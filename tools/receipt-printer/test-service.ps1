# Exercises the real service loop and DPAPI across user accounts. A loopback server
# and a file sink replace PMS and the printer in this isolated build only.
$ErrorActionPreference='Stop'
$id=[Guid]::NewGuid().ToString('N')
$name='PmsReceiptTest'+$id
$dir=Join-Path $env:ProgramData ('PmsReceiptTest-'+$id)
$listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
$created=$false
try {
  New-Item -ItemType Directory $dir | Out-Null
  $acl=Get-Acl $dir
  $account=[Security.Principal.SecurityIdentifier]::new('S-1-5-19')
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($account,'Modify','ContainerInherit,ObjectInherit','None','Allow'))
  Set-Acl $dir $acl
  $listener.Start()
  $port=$listener.LocalEndpoint.Port
  $service=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'ReceiptService.cs')).Replace('"PmsReceiptPrinter"',('"'+$name+'"')).Replace('Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),"PMS","ReceiptPrinter","State")',('@"'+$dir+'"')).Replace('https://prsznh.cn/api/v1/receipt-print-agent/',("http://127.0.0.1:"+$port+"/"))
  if($service.Contains('prsznh.cn') -or $service.Contains('SpecialFolder.ProgramFiles')){throw '隔离路径校验失败'}
  $service=$service.Replace('ServicePointManager.SecurityProtocol=', 'if(args.Contains("--seed")){SaveBinding(new Binding{token="synthetic-token",queue="synthetic-only"});return 0;} ServicePointManager.SecurityProtocol=')
  [IO.File]::WriteAllText((Join-Path $dir 'Service.cs'),$service)
  @"
using System;using System.IO;using System.Windows.Forms;
internal class Setup:Form{}
internal static class RollPrinter {
 public static bool Ready(string q){return q=="synthetic-only";}
 public static byte[] Encode(string[] lines){throw new NotImplementedException();}
 public static void Print(string q,int id,string[] lines){File.AppendAllText(Path.Combine(ReceiptService.Root,"sink.txt"),id+" "+lines[0]+Environment.NewLine);}
}
"@ | Set-Content "$dir/Sink.cs"
  $exe=Join-Path $dir Service.exe
  & "$env:WINDIR/Microsoft.NET/Framework64/v4.0.30319/csc.exe" /nologo /target:exe /codepage:65001 "/out:$exe" /r:System.Windows.Forms.dll /r:System.ServiceProcess.dll /r:System.Web.Extensions.dll /r:System.Security.dll (Join-Path $dir Service.cs) (Join-Path $dir Sink.cs)
  if($LASTEXITCODE -ne 0){throw '隔离服务编译失败'}
  & $exe --seed
  if($LASTEXITCODE -ne 0){throw 'DPAPI 配置失败'}
  & sc.exe create $name binPath= ("`""+$exe+"`" --service") start= demand obj= 'NT AUTHORITY\LocalService' | Out-Null
  if($LASTEXITCODE -ne 0){throw '创建隔离 Windows 服务失败'}
  $created=$true
  Start-Service $name
  $deadline=[DateTime]::UtcNow.AddSeconds(38)
  $states=@()
  while([DateTime]::UtcNow -lt $deadline -and $states.Count -lt 2){
    if(!$listener.Pending()){Start-Sleep -Milliseconds 100;continue}
    $client=$listener.AcceptTcpClient()
    try {
      $stream=$client.GetStream();$stream.ReadTimeout=4000
      $reader=[IO.StreamReader]::new($stream,[Text.Encoding]::ASCII)
      $first=$reader.ReadLine();$headers=@{}
      while($line=$reader.ReadLine()){ $key,$value=$line -split ':',2;$headers[$key]=$value.Trim() }
      if($headers['Authorization'] -ne 'Bearer synthetic-token'){throw '服务凭据回读失败'}
      if($headers['Expect'] -eq '100-continue'){$continue=[Text.Encoding]::ASCII.GetBytes("HTTP/1.1 100 Continue`r`n`r`n");$stream.Write($continue,0,$continue.Length)}
      $chars=New-Object char[] ([int]$headers['Content-Length'])
      $null=$reader.ReadBlock($chars,0,$chars.Length)
      if($first -match 'POST /next '){$json='{"job":{"id":11,"lines":["synthetic"]}}'}
      elseif($first -match 'POST /report '){$states+=((-join $chars)|ConvertFrom-Json).state;$json='{"ok":true}'}
      else{throw '未知请求'}
      $bytes=[Text.Encoding]::ASCII.GetBytes(("HTTP/1.1 200 OK`r`nContent-Type: application/json`r`nContent-Length: "+$json.Length+"`r`nConnection: close`r`n`r`n"+$json))
      $stream.Write($bytes,0,$bytes.Length)
    } finally {$client.Close()}
  }
  if(($states -join ',') -ne 'spooled,unknown' -or (Get-Content "$dir/sink.txt" -Raw).Trim() -ne '11 synthetic' -or !(Test-Path "$dir/check-paper")){throw '未验证一次提交与重复任务熔断'}
  Write-Output 'PASS LocalService 启动、DPAPI 读取、回环领取和回执；相同编号下发两次，只写入合成队列一次，随后暂停。'
} finally {
  $listener.Stop()
  if($created){Stop-Service $name -ErrorAction SilentlyContinue;& sc.exe delete $name | Out-Null}
  if((Test-Path $dir) -and (Resolve-Path $dir).Path -eq (Join-Path ([IO.Path]::GetFullPath($env:ProgramData)) ('PmsReceiptTest-'+$id))){Remove-Item -LiteralPath $dir -Force -Recurse}
}
