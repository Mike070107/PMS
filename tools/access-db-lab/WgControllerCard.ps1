param(
  [Parameter(Mandatory = $true)][ValidateSet('Query', 'Add')][string]$Operation,
  [Parameter(Mandatory = $true)][string]$IpAddress,
  [int]$Port = 60000,
  [Parameter(Mandatory = $true)][uint32]$ControllerSn,
  [Parameter(Mandatory = $true)][uint32]$CardNo,
  [ValidateSet('Tcp', 'Udp')][string]$Transport = 'Tcp',
  [datetime]$BeginDate = (Get-Date).Date,
  [datetime]$EndDate = [datetime]'2040-12-31',
  [ValidateRange(1, 4)][int[]]$Doors = @(1),
  [int]$TimeoutMs = 2000
)

$ErrorActionPreference = 'Stop'

function To-Bcd([int]$value) {
  return [byte]((([math]::Floor($value / 10)) -shl 4) -bor ($value % 10))
}

function Copy-UInt32LittleEndian([byte[]]$buffer, [int]$offset, [uint32]$value) {
  $bytes = [BitConverter]::GetBytes($value)
  [Array]::Copy($bytes, 0, $buffer, $offset, 4)
}

$command = if ($Operation -eq 'Add') { [byte]0x50 } else { [byte]0x5A }
$packet = New-Object byte[] 64
$packet[0] = 0x17
$packet[1] = $command
Copy-UInt32LittleEndian $packet 4 $ControllerSn
Copy-UInt32LittleEndian $packet 8 $CardNo
if ($Operation -eq 'Add') {
  $packet[12] = To-Bcd ($BeginDate.Year / 100)
  $packet[13] = To-Bcd ($BeginDate.Year % 100)
  $packet[14] = To-Bcd $BeginDate.Month
  $packet[15] = To-Bcd $BeginDate.Day
  $packet[16] = To-Bcd ($EndDate.Year / 100)
  $packet[17] = To-Bcd ($EndDate.Year % 100)
  $packet[18] = To-Bcd $EndDate.Month
  $packet[19] = To-Bcd $EndDate.Day
  foreach ($door in $Doors) { $packet[19 + $door] = 1 }
}

$client = $null
try {
  if ($Transport -eq 'Tcp') {
    $client = New-Object System.Net.Sockets.TcpClient
    $connect = $client.BeginConnect($IpAddress, $Port, $null, $null)
    if (-not $connect.AsyncWaitHandle.WaitOne($TimeoutMs)) { throw 'Controller TCP connection timed out.' }
    $client.EndConnect($connect)
    $client.ReceiveTimeout = $TimeoutMs
    $client.SendTimeout = $TimeoutMs
    $stream = $client.GetStream()
    $stream.Write($packet, 0, $packet.Length)
    $response = New-Object byte[] 64
    $received = 0
    while ($received -lt 64) {
      $count = $stream.Read($response, $received, 64 - $received)
      if ($count -eq 0) { break }
      $received += $count
    }
    if ($received -ne $response.Length) { [Array]::Resize([ref]$response, $received) }
  }
  else {
    $client = New-Object System.Net.Sockets.UdpClient
    $client.Client.ReceiveTimeout = $TimeoutMs
    $endpoint = New-Object System.Net.IPEndPoint([Net.IPAddress]::Parse($IpAddress), $Port)
    [void]$client.Send($packet, $packet.Length, $endpoint)
    $remote = New-Object System.Net.IPEndPoint([Net.IPAddress]::Any, 0)
    $response = $client.Receive([ref]$remote)
  }
  if ($response.Length -lt 12) { throw "Controller returned only $($response.Length) bytes." }
  if ($response[0] -ne 0x17 -or $response[1] -ne $command) { throw 'Controller response command does not match.' }
  $responseSn = [BitConverter]::ToUInt32($response, 4)
  if ($responseSn -ne $ControllerSn) { throw "Controller SN mismatch: $responseSn." }
  $returnedCard = [BitConverter]::ToUInt32($response, 8)
  $success = if ($Operation -eq 'Add') { $response[8] -eq 1 } else { $returnedCard -eq $CardNo }
  [pscustomobject]@{
    operation = $Operation
    controller = "$Transport $IpAddress`:$Port"
    controllerSn = $responseSn
    requestedCard = $CardNo
    returnedCard = $returnedCard
    success = $success
    responseBytes = $response.Length
  } | ConvertTo-Json -Compress
  if (-not $success) { exit 2 }
}
finally { if ($client) { $client.Close() } }
