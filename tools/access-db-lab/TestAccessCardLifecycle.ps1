param(
  [Parameter(Mandatory = $true)][ValidateSet('extend', 'lost', 'unlost', 'cancel')][string]$Operation,
  [Parameter(Mandatory = $true)][ValidatePattern('^\d{8}$')][string]$WgCardNo,
  [Parameter(Mandatory = $true)][switch]$ConfirmCopy,
  [string]$MjSystemPath = 'D:\PMS-Access-Backups\20260930-125356\MJDataBase.mdb',
  [string]$IcCardPath = 'D:\PMS-Access-Backups\20260930-125356\iCCard.mdb',
  [string]$EndDate = '',
  [string]$LostStatus = '',
  [string]$CancelStatus = '',
  [string]$NormalStatus = '0',
  [int[]]$RestoreDoorIds = @(),
  [switch]$AllowNonPms,
  [switch]$Keep,
  [string]$PasswordEnvVar = 'PMS_ICCard_MdbPassword',
  [string]$OutputPath = ''
)

# Write test for .88 card lifecycle. Only local copies are allowed; default is a
# transaction that is rolled back after verification, so no residue is left.
if ([IntPtr]::Size -ne 4) {
  $ps32 = Join-Path $env:SystemRoot 'SysWOW64\WindowsPowerShell\v1.0\powershell.exe'
  if (-not (Test-Path -LiteralPath $ps32)) { throw '32-bit PowerShell is required for Microsoft.Jet.OLEDB.4.0 / ACE OLEDB.' }
  $childArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath,
    '-Operation', $Operation, '-WgCardNo', $WgCardNo, '-ConfirmCopy',
    '-MjSystemPath', $MjSystemPath, '-IcCardPath', $IcCardPath,
    '-NormalStatus', $NormalStatus, '-PasswordEnvVar', $PasswordEnvVar)
  if ($Operation -eq 'extend') { $childArgs += @('-EndDate', $EndDate) }
  if (-not [string]::IsNullOrWhiteSpace($LostStatus)) { $childArgs += @('-LostStatus', $LostStatus) }
  if (-not [string]::IsNullOrWhiteSpace($CancelStatus)) { $childArgs += @('-CancelStatus', $CancelStatus) }
  if ($RestoreDoorIds.Count -gt 0) { $childArgs += @('-RestoreDoorIds', ($RestoreDoorIds -join ',')) }
  if ($AllowNonPms) { $childArgs += '-AllowNonPms' }
  if ($Keep) { $childArgs += '-Keep' }
  if (-not [string]::IsNullOrWhiteSpace($OutputPath)) { $childArgs += @('-OutputPath', $OutputPath) }
  & $ps32 @childArgs
  exit $LASTEXITCODE
}
if (-not $ConfirmCopy) { throw 'Refusing to run: pass -ConfirmCopy after verifying both paths are local backup copies.' }
foreach ($path in @($MjSystemPath, $IcCardPath)) {
  if ([string]::IsNullOrWhiteSpace($path)) { continue }
  if ($path.StartsWith('\\')) { throw ('Refusing network path: ' + $path + '. Copy the MDB locally first.') }
}
if ($Operation -eq 'extend' -and [string]::IsNullOrWhiteSpace($EndDate)) { throw 'extend requires -EndDate yyyy-MM-dd' }

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
    } catch { $errors += ($provider + ': ' + $_.Exception.Message) }
  }
  throw ('Cannot open ' + $name + ' (' + ($errors -join '; ') + '). Install Jet 4.0 or ACE OLEDB 12.0.')
}

function Get-Scalar($connection, $transaction, [string]$sql, [object[]]$values = @()) {
  $command = $connection.CreateCommand()
  $command.Transaction = $transaction
  $command.CommandText = $sql
  foreach ($value in $values) { [void]$command.Parameters.AddWithValue('@value', $value) }
  return $command.ExecuteScalar()
}

function Invoke-Sql($connection, $transaction, [string]$sql, [object[]]$values = @()) {
  $command = $connection.CreateCommand()
  $command.Transaction = $transaction
  $command.CommandText = $sql
  foreach ($value in $values) { [void]$command.Parameters.AddWithValue('@value', $value) }
  return $command.ExecuteNonQuery()
}

function Get-NullableDate($value) {
  if ($null -eq $value -or $value -is [System.DBNull]) { return $null }
  return [datetime]$value
}

function Format-Date($value) {
  $date = Get-NullableDate $value
  if ($null -eq $date) { return $null }
  return $date.ToString('yyyy-MM-dd')
}

function Test-PmsRecord([string]$value) {
  if ([string]::IsNullOrWhiteSpace($value)) { return $false }
  return $value.Trim().StartsWith('PMS_') -or $value.Contains('PMS_')
}

function New-Row([string]$system) {
  return [ordered]@{
    accessSystem = $system
    status       = 'failed'
    detail       = $null
    beforeValue  = $null
    afterValue   = $null
    error        = $null
    committed    = [bool]$Keep
  }
}

function Finish-System($connection, $transaction, [bool]$keep) {
  if ($keep) { $transaction.Commit() } else { $transaction.Rollback() }
}

$rows = @()

function Test-MjSystemExtend {
  $row = New-Row 'mjsystem'
  try {
    $connection = New-AccessConnection $MjSystemPath $null 'MjSystem'
    $transaction = $connection.BeginTransaction()
    try {
      $command = $connection.CreateCommand()
      $command.Transaction = $transaction
      $command.CommandText = 'SELECT EId,vEmp_name,dBeginDate,dEndDate,EmpMemo FROM Employee WHERE vCardNo=?'
      [void]$command.Parameters.AddWithValue('@value', $WgCardNo)
      $reader = $command.ExecuteReader()
      if (-not $reader.Read()) { $reader.Close(); $transaction.Rollback(); $row.status = 'skipped'; $row.detail = 'MjSystem has no employee row for this card'; return $row }
      $employeeId = [int]$reader['EId']
      $employeeName = [string]$reader['vEmp_name']
      $before = Format-Date $reader['dEndDate']
      $reader.Close()
      if ($before -eq $EndDate) { $transaction.Rollback(); $row.status = 'skipped'; $row.detail = 'end date already equals target'; $row.beforeValue = $before; $row.afterValue = $before; return $row }
      [void](Invoke-Sql $connection $transaction 'UPDATE Employee SET dEndDate=? WHERE EId=?' @([datetime]::ParseExact($EndDate, 'yyyy-MM-dd', $null), $employeeId))
      $after = Format-Date (Get-Scalar $connection $transaction 'SELECT dEndDate FROM Employee WHERE EId=?' @($employeeId))
      if ($after -ne $EndDate) { throw ('readback mismatch: ' + $after) }
      Finish-System $connection $transaction $Keep
      $row.status = 'completed'
      $row.detail = 'Employee EId=' + $employeeId + ' name=' + $employeeName + '; controller re-upload is still required for the device to take effect'
      $row.beforeValue = $before
      $row.afterValue = $after
    } catch { try { $transaction.Rollback() } catch { }; throw } finally { $connection.Close() }
  } catch { $row.error = $_.Exception.Message }
  return $row
}

function Test-MjSystemCancel {
  $row = New-Row 'mjsystem'
  try {
    $connection = New-AccessConnection $MjSystemPath $null 'MjSystem'
    $transaction = $connection.BeginTransaction()
    try {
      $command = $connection.CreateCommand()
      $command.Transaction = $transaction
      $command.CommandText = 'SELECT EId,EmpMemo FROM Employee WHERE vCardNo=?'
      [void]$command.Parameters.AddWithValue('@value', $WgCardNo)
      $reader = $command.ExecuteReader()
      if (-not $reader.Read()) { $reader.Close(); $transaction.Rollback(); $row.status = 'skipped'; $row.detail = 'MjSystem has no employee row; treated as already cancelled'; return $row }
      $employeeId = [int]$reader['EId']
      $memo = [string]$reader['EmpMemo']
      $reader.Close()
      if (-not $AllowNonPms -and -not (Test-PmsRecord $memo)) { $transaction.Rollback(); throw 'record has no PMS_ marker; pass -AllowNonPms to cancel a historical card' }
      $permissionCount = [int](Get-Scalar $connection $transaction 'SELECT COUNT(*) FROM MJ_MacPower WHERE cCardNo=?' @($WgCardNo))
      [void](Invoke-Sql $connection $transaction 'DELETE FROM MJ_MacPower WHERE cCardNo=?' @($WgCardNo))
      [void](Invoke-Sql $connection $transaction 'DELETE FROM Employee WHERE EId=?' @($employeeId))
      $remEmployees = [int](Get-Scalar $connection $transaction 'SELECT COUNT(*) FROM Employee WHERE vCardNo=?' @($WgCardNo))
      $remPermissions = [int](Get-Scalar $connection $transaction 'SELECT COUNT(*) FROM MJ_MacPower WHERE cCardNo=?' @($WgCardNo))
      if ($remEmployees -ne 0 -or $remPermissions -ne 0) { throw ('readback mismatch: employees=' + $remEmployees + ' permissions=' + $remPermissions) }
      Finish-System $connection $transaction $Keep
      $row.status = 'completed'
      $row.detail = 'Employee EId=' + $employeeId + ' deleted with ' + $permissionCount + ' permission row(s); rolled back=' + (-not [bool]$Keep)
      $row.beforeValue = 'permissions=' + $permissionCount
      $row.afterValue = 'permissions=0'
    } catch { try { $transaction.Rollback() } catch { }; throw } finally { $connection.Close() }
  } catch { $row.error = $_.Exception.Message }
  return $row
}

function Get-IcCardRow($connection, $transaction) {
  $command = $connection.CreateCommand()
  $command.Transaction = $transaction
  $command.CommandText = 'SELECT I.f_CardID,I.f_ConsumerID,C.f_EndYMD,I.f_Deadline,I.f_CardStatusDesc,I.f_LostDate,I.f_DeletedDate,C.f_Note FROM (t_b_IDCard AS I INNER JOIN t_b_Consumer AS C ON I.f_ConsumerID=C.f_ConsumerID) WHERE I.f_CardNO=?'
  [void]$command.Parameters.AddWithValue('@value', $WgCardNo)
  $reader = $command.ExecuteReader()
  if (-not $reader.Read()) { $reader.Close(); return $null }
  $result = [pscustomobject]@{
    CardID       = [int]$reader['f_CardID']
    ConsumerID   = [int]$reader['f_ConsumerID']
    EndDate      = Get-NullableDate $reader['f_EndYMD']
    Deadline     = Get-NullableDate $reader['f_Deadline']
    Status       = [string]$reader['f_CardStatusDesc']
    LostDate     = Get-NullableDate $reader['f_LostDate']
    DeletedDate  = Get-NullableDate $reader['f_DeletedDate']
    Note         = [string]$reader['f_Note']
  }
  $reader.Close()
  return $result
}

function Test-IcCard([string]$password) {
  $row = New-Row 'iccard'
  if ([string]::IsNullOrEmpty($password)) {
    $row.error = 'iCCard password is not set (env var ' + $PasswordEnvVar + '); copy tests need the MDB password installed on .88'
    return $row
  }
  try {
    $connection = New-AccessConnection $IcCardPath $password 'iCCard'
    $transaction = $connection.BeginTransaction()
    try {
      $card = Get-IcCardRow $connection $transaction
      if ($null -eq $card) { $transaction.Rollback(); $row.status = 'skipped'; $row.detail = 'iCCard has no card row for this WG number; treated as already cancelled'; return $row }
      if ($Operation -eq 'extend') {
        $before = Format-Date $card.EndDate
        if ($before -eq $EndDate -and $null -ne $card.Deadline -and (Format-Date $card.Deadline) -eq $EndDate) {
          $transaction.Rollback(); $row.status = 'skipped'; $row.detail = 'end date already equals target'; $row.beforeValue = $before; $row.afterValue = $before; return $row
        }
        [void](Invoke-Sql $connection $transaction 'UPDATE t_b_Consumer SET f_EndYMD=? WHERE f_ConsumerID=?' @([datetime]::ParseExact($EndDate, 'yyyy-MM-dd', $null), $card.ConsumerID))
        [void](Invoke-Sql $connection $transaction 'UPDATE t_b_IDCard SET f_Deadline=? WHERE f_CardID=?' @([datetime]::ParseExact($EndDate, 'yyyy-MM-dd', $null), $card.CardID))
        $after = Format-Date (Get-Scalar $connection $transaction 'SELECT f_EndYMD FROM t_b_Consumer WHERE f_ConsumerID=?' @($card.ConsumerID))
        $deadline = Format-Date (Get-Scalar $connection $transaction 'SELECT f_Deadline FROM t_b_IDCard WHERE f_CardID=?' @($card.CardID))
        if ($after -ne $EndDate -or $deadline -ne $EndDate) { throw ('readback mismatch: end=' + $after + ' deadline=' + $deadline) }
        Finish-System $connection $transaction $Keep
        $row.status = 'completed'; $row.detail = 'iCCard CardID=' + $card.CardID + ' ConsumerID=' + $card.ConsumerID + '; controller re-upload is still required'
        $row.beforeValue = $before; $row.afterValue = $after
      } elseif ($Operation -eq 'lost' -or $Operation -eq 'cancel') {
        $targetStatus = if ($Operation -eq 'lost') { $LostStatus } else { $CancelStatus }
        if ([string]::IsNullOrWhiteSpace($targetStatus)) { $transaction.Rollback(); throw ($Operation + ' status code is not configured (pass -LostStatus / -CancelStatus after field evidence)') }
        if ($Operation -eq 'lost' -and $null -ne $card.LostDate -and $card.Status -eq $targetStatus) { $transaction.Rollback(); $row.status = 'skipped'; $row.detail = 'card is already lost'; return $row }
        if ($Operation -eq 'cancel' -and $null -ne $card.DeletedDate) { $transaction.Rollback(); $row.status = 'skipped'; $row.detail = 'card is already cancelled'; return $row }
        if (-not $AllowNonPms -and -not (Test-PmsRecord $card.Note)) { $transaction.Rollback(); throw 'card has no PMS_ marker; pass -AllowNonPms to operate on a historical card' }
        $privilegeCount = [int](Get-Scalar $connection $transaction 'SELECT COUNT(*) FROM t_d_Privilege WHERE f_ConsumerID=?' @($card.ConsumerID))
        $now = Get-Date
        if ($Operation -eq 'lost') {
          [void](Invoke-Sql $connection $transaction 'UPDATE t_b_IDCard SET f_CardStatusDesc=?,f_LostDate=?,f_StatusChangeDate=? WHERE f_CardID=?' @($targetStatus, $now, $now, $card.CardID))
        } else {
          [void](Invoke-Sql $connection $transaction 'UPDATE t_b_IDCard SET f_CardStatusDesc=?,f_DeletedDate=?,f_StatusChangeDate=? WHERE f_CardID=?' @($targetStatus, $now, $now, $card.CardID))
        }
        [void](Invoke-Sql $connection $transaction 'DELETE FROM t_d_Privilege WHERE f_ConsumerID=?' @($card.ConsumerID))
        $savedStatus = [string](Get-Scalar $connection $transaction 'SELECT f_CardStatusDesc FROM t_b_IDCard WHERE f_CardID=?' @($card.CardID))
        $remaining = [int](Get-Scalar $connection $transaction 'SELECT COUNT(*) FROM t_d_Privilege WHERE f_ConsumerID=?' @($card.ConsumerID))
        if ($savedStatus -ne $targetStatus -or $remaining -ne 0) { throw ('readback mismatch: status=' + $savedStatus + ' privileges=' + $remaining) }
        Finish-System $connection $transaction $Keep
        $row.status = 'completed'; $row.detail = 'iCCard CardID=' + $card.CardID + ' status=' + $targetStatus + '; removed ' + $privilegeCount + ' privilege row(s); card row kept for audit'
        $row.beforeValue = 'status=' + $card.Status + ' privileges=' + $privilegeCount
        $row.afterValue = 'status=' + $savedStatus + ' privileges=0'
      } elseif ($Operation -eq 'unlost') {
        if ([string]::IsNullOrWhiteSpace($NormalStatus)) { $transaction.Rollback(); throw 'normal status code is empty' }
        if ($null -eq $card.LostDate) { $transaction.Rollback(); $row.status = 'skipped'; $row.detail = 'card is not in lost state'; return $row }
        if ($RestoreDoorIds.Count -eq 0) { $transaction.Rollback(); throw 'unlost requires -RestoreDoorIds (door id list from the lost operation) or the card will have no access' }
        if (-not $AllowNonPms -and -not (Test-PmsRecord $card.Note)) { $transaction.Rollback(); throw 'card has no PMS_ marker; pass -AllowNonPms to operate on a historical card' }
        [void](Invoke-Sql $connection $transaction 'UPDATE t_b_IDCard SET f_CardStatusDesc=?,f_LostDate=NULL,f_StatusChangeDate=? WHERE f_CardID=?' @($NormalStatus, (Get-Date), $card.CardID))
        foreach ($doorId in ($RestoreDoorIds | Select-Object -Unique)) {
          $exists = [int](Get-Scalar $connection $transaction 'SELECT COUNT(*) FROM t_d_Privilege WHERE f_ConsumerID=? AND f_DoorID=?' @($card.ConsumerID, $doorId))
          if ($exists -eq 0) { [void](Invoke-Sql $connection $transaction 'INSERT INTO t_d_Privilege (f_DoorID,f_ControlSegID,f_ConsumerID) VALUES (?,?,?)' @($doorId, 1, $card.ConsumerID)) }
        }
        $savedStatus = [string](Get-Scalar $connection $transaction 'SELECT f_CardStatusDesc FROM t_b_IDCard WHERE f_CardID=?' @($card.CardID))
        $lostDate = Get-Scalar $connection $transaction 'SELECT f_LostDate FROM t_b_IDCard WHERE f_CardID=?' @($card.CardID)
        $privilegeCount = [int](Get-Scalar $connection $transaction 'SELECT COUNT(*) FROM t_d_Privilege WHERE f_ConsumerID=?' @($card.ConsumerID))
        if ($savedStatus -ne $NormalStatus -or $null -ne (Get-NullableDate $lostDate) -or $privilegeCount -ne ($RestoreDoorIds | Select-Object -Unique).Count) { throw 'readback mismatch after unlost' }
        Finish-System $connection $transaction $Keep
        $row.status = 'completed'; $row.detail = 'iCCard CardID=' + $card.CardID + ' restored status=' + $NormalStatus + ' and ' + $privilegeCount + ' door privilege(s); controller re-upload is still required'
        $row.beforeValue = 'status=' + $card.Status + ' lost=' + (Format-Date $card.LostDate)
        $row.afterValue = 'status=' + $savedStatus + ' privileges=' + $privilegeCount
      } else { throw ('unsupported operation: ' + $Operation) }
    } catch { try { $transaction.Rollback() } catch { }; throw } finally { $connection.Close() }
  } catch { $row.error = $_.Exception.Message }
  return $row
}

# Rebuild rows deterministically: one MjSystem row + one iCCard row.
$rows = @()
if ($Operation -eq 'extend') { $rows += Test-MjSystemExtend }
if ($Operation -eq 'cancel') { $rows += Test-MjSystemCancel }
if ($Operation -eq 'lost' -or $Operation -eq 'unlost') {
  $mjRow = New-Row 'mjsystem'
  $mjRow.error = 'MjSystem has no lost/unlost field; PMS must not guess original-software behaviour'
  $rows += $mjRow
}
$rows += Test-IcCard ([Environment]::GetEnvironmentVariable($PasswordEnvVar))
foreach ($row in $rows) { $row.committed = [bool]$Keep }

$output = [pscustomobject]@{
  operation = $Operation
  wgCardNo  = $WgCardNo
  mode      = $(if ($Keep) { 'commit' } else { 'rollback' })
  rows      = @($rows)
}
$json = $output | ConvertTo-Json -Depth 7
if ($OutputPath) { [IO.File]::WriteAllText($OutputPath, $json, (New-Object System.Text.UTF8Encoding($false))) } else { $json }
if (@($rows | Where-Object { $_.status -eq 'completed' }).Count -gt 0) { exit 0 }
if (@($rows | Where-Object { $_.status -eq 'skipped' }).Count -gt 0) { exit 0 }
exit 4
