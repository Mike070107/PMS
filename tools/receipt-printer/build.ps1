$ErrorActionPreference='Stop'
Push-Location $PSScriptRoot
try {
  $dir=Join-Path $PSScriptRoot '../../apps/neighbor-web/public/downloads/receipt-printer'
  New-Item -Force -ItemType Directory $dir | Out-Null
  $exe=Join-Path $dir 'PmsReceiptPrinter.exe'
  & "$env:WINDIR/Microsoft.NET/Framework64/v4.0.30319/csc.exe" /nologo /target:winexe /platform:anycpu /optimize+ /codepage:65001 /win32manifest:app.manifest "/out:$exe" /reference:System.ServiceProcess.dll /reference:System.Security.dll /reference:System.Web.Extensions.dll /reference:System.Windows.Forms.dll /reference:System.Drawing.dll RollPrinter.cs ReceiptService.cs Setup.cs
  if($LASTEXITCODE -ne 0){throw '打印助手编译失败'}
  $check=Start-Process -FilePath $exe -ArgumentList '--self-test' -Wait -PassThru -WindowStyle Hidden
  if($check.ExitCode -ne 0){throw '小票编码自检失败'}
  Get-FileHash $exe -Algorithm SHA256
} finally {Pop-Location}
