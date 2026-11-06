param(
  [Parameter(Mandatory = $true)][string]$Term,
  [ValidateSet('auto', 'card', 'room', 'name')][string]$Mode = 'auto',
  [string]$MjSystemPath = 'D:\PMS-Access-Backups\20260930-125356\MJDataBase.mdb',
  [string]$IcCardPath = 'D:\PMS-Access-Backups\20260930-125356\iCCard.mdb',
  [string]$PasswordEnvVar = 'PMS_ICCard_MdbPassword',
  [string]$OutputPath = ''
)

# Read-only query over the two .88 Access MDBs. Jet/ACE OleDb is 32-bit only,
# so a 64-bit PowerShell session re-launches this script under 32-bit PowerShell.
if ([IntPtr]::Size -ne 4) {
  $ps32 = Join-Path $env:SystemRoot 'SysWOW64\WindowsPowerShell\v1.0\powershell.exe'
  if (-not (Test-Path -LiteralPath $ps32)) { throw '32-bit PowerShell is required for Microsoft.Jet.OLEDB.4.0 / ACE OLEDB.' }
  $childArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath,
    '-Term', $Term, '-Mode', $Mode,
    '-MjSystemPath', $MjSystemPath, '-IcCardPath', $IcCardPath,
    '-PasswordEnvVar', $PasswordEnvVar)
  if (-not [string]::IsNullOrWhiteSpace($OutputPath)) { $childArgs += @('-OutputPath', $OutputPath) }
  & $ps32 @childArgs
  exit $LASTEXITCODE
}

$ErrorActionPreference = 'Stop'

function New-AccessConnection([string]$path, [string]$password, [string]$name) {
  if ([string]::IsNullOrWhiteSpace($path)) { throw ($name + ' database path is empty') }
  if (-not (Test-Path -LiteralPath $path)) { throw ($name + ' database not found: ' + $path) }
  $errors = @()
  foreach ($provider in @('Microsoft.Jet.OLEDB.4.0', 'Microsoft.ACE.OLEDB.12.0')) {
    try {
      $builder = New-Object System.Data.OleDb.OleDbConnectionStringBuilder
      $builder.Provider = $provider
      $builder['Data Source'] = $path
      if (-not [string]::IsNullOrEmpty($password)) { $builder['Jet OLEDB:Database Password'] = $password }
      $connection = New-Object System.Data.OleDb.OleDbConnection($builder.ConnectionString)
      $connection.Open()
      return $connection
    } catch {
      $errors += ($provider + ': ' + $_.Exception.Message)
    }
  }
  throw ('Cannot open ' + $name + ' (' + ($errors -join '; ') + '). Install Jet 4.0 or ACE OLEDB 12.0.')
}

function Get-Rows($connection, [string]$sql, [object[]]$values = @()) {
  $command = $connection.CreateCommand()
  $command.CommandText = $sql
  foreach ($value in $values) { [void]$command.Parameters.AddWithValue('@value', $value) }
  $table = New-Object System.Data.DataTable
  $adapter = New-Object System.Data.OleDb.OleDbDataAdapter($command)
  [void]$adapter.Fill($table)
  $rows = @()
  foreach ($row in $table.Rows) {
    $item = [ordered]@{}
    foreach ($column in $table.Columns) {
      $value = $row[$column]
      $item[$column.ColumnName] = if ($value -is [System.DBNull]) { $null } else { $value }
    }
    $rows += [pscustomobject]$item
  }
  return $rows
}

function Get-Text($row, [string]$name) {
  if (-not $row) { return $null }
  $value = $row.$name
  if ($null -eq $value -or $value -is [System.DBNull]) { return $null }
  return ([string]$value).Trim()
}

function Get-TimeText($row, [string]$name) {
  $value = $row.$name
  if ($null -eq $value -or $value -is [System.DBNull]) { return $null }
  return ([datetime]$value).ToString('o')
}

function Get-CardVariants([string]$cardNo) {
  $normalized = ($cardNo -replace '\s', '').Trim().ToUpperInvariant()
  $values = New-Object System.Collections.Generic.List[string]
  $values.Add($normalized)
  if ($normalized -match '^[0-9]+$') {
    if ($normalized.Length -lt 8) { $values.Add($normalized.PadLeft(8, '0')) }
    if ($normalized.Length -gt 1 -and $normalized.StartsWith('0')) {
      $trimmed = $normalized.TrimStart('0')
      if ($trimmed.Length -gt 0) { $values.Add($trimmed) }
    }
  }
  return @($values | Sort-Object -Unique)
}

function Test-RoomName([string]$name, [string]$roomKey) {
  $parts = $roomKey.Split('/')
  if ($parts.Length -ne 3) { throw ('room key must be lane/building/room: ' + $roomKey) }
  $match = [regex]::Match($name, '(?<!\d)(\d+)\s*[/\uFF0F\\-]\s*(\d+)\s*[/\uFF0F\\-]\s*(\d+)\s*[/\uFF0F\\-]\s*(\d+)(?!\d)')
  if (-not $match.Success) { return $false }
  return ([int]$match.Groups[1].Value -eq [int]$parts[0]) -and
         ([int]$match.Groups[2].Value -eq [int]$parts[1]) -and
         ([int]$match.Groups[3].Value -eq [int]$parts[2])
}

function Add-CardUnique([object[]]$target, $card) {
  foreach ($current in $target) {
    if ($current.accessSystem -eq $card.accessSystem -and
        ($current.cardNo.TrimStart('0') -eq $card.cardNo.TrimStart('0'))) { return $target }
  }
  return @($target + $card)
}

function Get-CardPermissions($connection, [string]$sql, [string]$sourceTable, [string]$system) {
  return @(Get-Rows $connection $sql @() | ForEach-Object {
    [pscustomobject]@{
      accessSystem = $system
      buildingNo   = $null
      controller   = $(if (Get-Text $_ 'controller') { Get-Text $_ 'controller' } else { $null })
      door         = $(if (Get-Text $_ 'door') { Get-Text $_ 'door' } else { Get-Text $_ 'doorId' })
      sourceTable  = $sourceTable
    }
  })
}

$resolved = $Mode
if ($resolved -eq 'auto') {
  if ($Term -match '^[0-9A-Fa-f]{6,}$') { $resolved = 'card' }
  elseif ($Term.Contains('/')) { $resolved = 'room' }
  else { $resolved = 'name' }
}
if ($Term -match '[%_\[]') { throw 'term must not contain LIKE wildcards (% _ [)' }
if ($resolved -eq 'room' -and $Term.Split('/').Length -ne 3) { throw 'room key must be lane/building/room' }

$cards = @()
$records = @()
$errors = @()

if (Test-Path -LiteralPath $MjSystemPath) {
  try {
    $mj = New-AccessConnection $MjSystemPath $null 'MjSystem'
    try {
      if ($resolved -eq 'card') {
        $candidates = Get-CardVariants $Term
      } else {
        $pattern = '%' + $Term + '%'
        $candidates = @(Get-Rows $mj 'SELECT TOP 100 vCardNo,vEmp_name FROM Employee WHERE vEmp_name LIKE ?' @($pattern) |
          ForEach-Object { Get-Text $_ 'vCardNo' } | Sort-Object -Unique)
      }
      foreach ($candidate in $candidates) {
        $employees = Get-Rows $mj 'SELECT EId,vEmp_id,vEmp_name,vCardNo,vDepart,dBeginDate,dEndDate,EmpMemo FROM Employee WHERE vCardNo=?' @($candidate)
        foreach ($employee in $employees) {
          $name = Get-Text $employee 'vEmp_name'
          if ($resolved -eq 'room' -and -not (Test-RoomName $name $Term)) { continue }
          $cardNo = Get-Text $employee 'vCardNo'
          $permissions = @(Get-Rows $mj 'SELECT P.cDoorId AS doorId,D.vDoorName AS door,M.vExposition AS controller FROM (MJ_MacPower AS P LEFT JOIN MJ_DoorInfo AS D ON P.cDoorId=D.cDoorId) LEFT JOIN MJ_MacInfo AS M ON D.cMacId=M.cMacId WHERE P.cCardNo=?' @($cardNo))
          $cards = Add-CardUnique $cards ([pscustomobject]@{
            accessSystem = 'mjsystem'
            cardNo       = $cardNo
            personName   = $name
            personNo     = Get-Text $employee 'vEmp_id'
            groupName    = Get-Text $employee 'vDepart'
            beginDate    = Get-TimeText $employee 'dBeginDate'
            endDate      = Get-TimeText $employee 'dEndDate'
            status       = $null
            issueDate    = $null
            deadline     = $null
            lostDate     = $null
            deletedDate  = $null
            memo         = Get-Text $employee 'EmpMemo'
            permissions  = @($permissions | ForEach-Object {
              [pscustomobject]@{
                accessSystem = 'mjsystem'
                buildingNo   = $null
                controller   = Get-Text $_ 'controller'
                door         = $(if (Get-Text $_ 'door') { Get-Text $_ 'door' } else { Get-Text $_ 'doorId' })
                sourceTable  = 'MJ_MacPower'
              }
            })
          })
          $records += Get-Rows $mj 'SELECT TOP 50 cCardNo,dTime,cDoorId,cStatus,vStatusType FROM MJ_MacRecord WHERE cCardNo=? ORDER BY dTime DESC' @($cardNo) |
            ForEach-Object {
              [pscustomobject]@{
                accessSystem = 'mjsystem'
                cardNo       = Get-Text $_ 'cCardNo'
                occurredAt   = Get-TimeText $_ 'dTime'
                door         = Get-Text $_ 'cDoorId'
                controller   = $null
                status       = Get-Text $_ 'cStatus'
                reader       = Get-Text $_ 'vStatusType'
                sourceTable  = 'MJ_MacRecord'
              }
            }
        }
      }
    } finally { $mj.Close() }
  } catch { $errors += ('MjSystem: ' + $_.Exception.Message) }
} else {
  $errors += ('MjSystem database not found: ' + $MjSystemPath)
}

$password = [Environment]::GetEnvironmentVariable($PasswordEnvVar)
if (Test-Path -LiteralPath $IcCardPath) {
  if ([string]::IsNullOrEmpty($password)) {
    $errors += ('iCCard: env var ' + $PasswordEnvVar + ' is not set; install the MDB password on the .88 machine first')
  } else {
    try {
      $ic = New-AccessConnection $IcCardPath $password 'iCCard'
      try {
        if ($resolved -eq 'card') {
          $candidates = Get-CardVariants $Term
        } else {
          $pattern = '%' + $Term + '%'
          $candidates = @(Get-Rows $ic 'SELECT TOP 100 I.f_CardNO FROM t_b_IDCard AS I LEFT JOIN t_b_Consumer AS C ON I.f_ConsumerID=C.f_ConsumerID WHERE C.f_ConsumerName LIKE ?' @($pattern) |
            ForEach-Object { Get-Text $_ 'f_CardNO' } | Sort-Object -Unique)
        }
        foreach ($candidate in $candidates) {
          $rows = Get-Rows $ic 'SELECT C.f_ConsumerID,C.f_ConsumerNO,C.f_ConsumerName,C.f_GroupID,G.f_GroupName,C.f_BeginYMD,C.f_EndYMD,I.f_CardID,I.f_CardNO,I.f_CardStatusDesc,I.f_IssueDate,I.f_Deadline,I.f_LostDate,I.f_DeletedDate FROM (t_b_IDCard AS I LEFT JOIN t_b_Consumer AS C ON I.f_ConsumerID=C.f_ConsumerID) LEFT JOIN t_b_Group AS G ON C.f_GroupID=G.f_GroupID WHERE I.f_CardNO=?' @($candidate)
          foreach ($row in $rows) {
            $consumerId = $row.f_ConsumerID
            $permissions = @()
            if ($resolved -eq 'room' -and -not (Test-RoomName (Get-Text $row 'f_ConsumerName') $Term)) { continue }
            if ($null -ne $consumerId -and $consumerId -isnot [System.DBNull]) {
              $permissions = @(Get-Rows $ic 'SELECT P.f_DoorID AS doorId,D.f_DoorName AS door,C.f_ControllerName AS controller FROM (t_d_Privilege AS P INNER JOIN t_b_Door AS D ON P.f_DoorID=D.f_DoorID) LEFT JOIN t_b_Controller AS C ON D.f_ControllerID=C.f_ControllerID WHERE P.f_ConsumerID=?' @([int]$consumerId))
            }
            $cards = Add-CardUnique $cards ([pscustomobject]@{
              accessSystem = 'iccard'
              cardNo       = Get-Text $row 'f_CardNO'
              personName   = Get-Text $row 'f_ConsumerName'
              personNo     = Get-Text $row 'f_ConsumerNO'
              groupName    = Get-Text $row 'f_GroupName'
              beginDate    = Get-TimeText $row 'f_BeginYMD'
              endDate      = Get-TimeText $row 'f_EndYMD'
              status       = Get-Text $row 'f_CardStatusDesc'
              issueDate    = Get-TimeText $row 'f_IssueDate'
              deadline     = Get-TimeText $row 'f_Deadline'
              lostDate     = Get-TimeText $row 'f_LostDate'
              deletedDate  = Get-TimeText $row 'f_DeletedDate'
              memo         = $null
              permissions  = @($permissions | ForEach-Object {
                [pscustomobject]@{
                  accessSystem = 'iccard'
                  buildingNo   = $null
                  controller   = Get-Text $_ 'controller'
                  door         = Get-Text $_ 'door'
                  sourceTable  = 't_d_Privilege'
                }
              })
            })
            $cardNo = Get-Text $row 'f_CardNO'
            $records += Get-Rows $ic 'SELECT TOP 50 f_CardNO,f_ReadDate,f_Character,f_ControllerSN,f_ReaderID FROM t_d_CardRecord WHERE f_CardNO=? ORDER BY f_ReadDate DESC' @($cardNo) |
              ForEach-Object {
                [pscustomobject]@{
                  accessSystem = 'iccard'
                  cardNo       = Get-Text $_ 'f_CardNO'
                  occurredAt   = Get-TimeText $_ 'f_ReadDate'
                  door         = $null
                  controller   = Get-Text $_ 'f_ControllerSN'
                  status       = Get-Text $_ 'f_Character'
                  reader       = Get-Text $_ 'f_ReaderID'
                  sourceTable  = 't_d_CardRecord'
                }
              }
          }
        }
      } finally { $ic.Close() }
    } catch { $errors += ('iCCard: ' + $_.Exception.Message) }
  }
} else {
  $errors += ('iCCard database not found: ' + $IcCardPath)
}

$output = [pscustomobject]@{
  term      = $Term
  matchedBy = $resolved
  cards     = @($cards)
  records   = @($records | Sort-Object { $_.occurredAt } -Descending | Select-Object -First 50)
  errors    = @($errors)
}
$json = $output | ConvertTo-Json -Depth 7
if ($OutputPath) {
  [IO.File]::WriteAllText($OutputPath, $json, (New-Object System.Text.UTF8Encoding($false)))
} else {
  $json
}
if ($cards.Count -eq 0 -and $errors.Count -gt 0) { exit 3 }
exit 0
