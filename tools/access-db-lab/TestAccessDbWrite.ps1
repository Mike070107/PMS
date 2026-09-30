param(
  [Parameter(Mandatory = $true)][ValidateSet('MjSystem26', 'IcCard11')][string]$Mode,
  [Parameter(Mandatory = $true)][string]$Path,
  [Parameter(Mandatory = $true)][ValidatePattern('^\d{8}$')][string]$WgCardNo,
  [string]$ConnectionConfigPath = '',
  [switch]$Keep
)

$ErrorActionPreference = 'Stop'
$marker = 'PMS_TEST_' + (Get-Date -Format 'yyyyMMddHHmmss')
$builder = if ($ConnectionConfigPath) {
  [xml]$config = Get-Content -LiteralPath $ConnectionConfigPath
  $configured = @($config.configuration.appSettings.add) |
    Where-Object { $_.key -eq 'dbConnection' } |
    Select-Object -First 1
  if (-not $configured -or -not $configured.value) { throw 'dbConnection was not found.' }
  New-Object System.Data.OleDb.OleDbConnectionStringBuilder([string]$configured.value)
}
else {
  $value = New-Object System.Data.OleDb.OleDbConnectionStringBuilder
  $value.Provider = 'Microsoft.Jet.OLEDB.4.0'
  $value
}
$builder['Data Source'] = $Path

function Add-Parameter($command, $type, $value) {
  $parameter = $command.Parameters.Add('@value', $type)
  $parameter.Value = $value
}

function Expand-ParameterValues($values) {
  foreach ($value in $values) {
    if ($value -is [array]) { Expand-ParameterValues $value }
    else { $value }
  }
}

function Scalar($connection, $transaction, $sql, $parameters) {
  $command = $connection.CreateCommand()
  $command.Transaction = $transaction
  $command.CommandText = $sql
  $flat = @(Expand-ParameterValues $parameters)
  if (($flat.Count % 2) -ne 0) { throw "Invalid SQL parameter pairs ($($flat.Count): $(@($flat | ForEach-Object { $_.GetType().Name }) -join ',')) for: $sql" }
  for ($index = 0; $index -lt $flat.Count; $index += 2) {
    Add-Parameter $command $flat[$index] $flat[$index + 1]
  }
  return $command.ExecuteScalar()
}

function Execute($connection, $transaction, $sql, $parameters) {
  $command = $connection.CreateCommand()
  $command.Transaction = $transaction
  $command.CommandText = $sql
  $flat = @(Expand-ParameterValues $parameters)
  if (($flat.Count % 2) -ne 0) { throw "Invalid SQL parameter pairs ($($flat.Count): $(@($flat | ForEach-Object { $_.GetType().Name }) -join ',')) for: $sql" }
  for ($index = 0; $index -lt $flat.Count; $index += 2) {
    Add-Parameter $command $flat[$index] $flat[$index + 1]
  }
  return $command.ExecuteNonQuery()
}

$connection = New-Object System.Data.OleDb.OleDbConnection($builder.ConnectionString)
$connection.Open()
$transaction = $connection.BeginTransaction()
try {
  $before = 0
  $afterInsert = 0
  $afterDelete = 0
  $ids = @{}
  $string = [System.Data.OleDb.OleDbType]::VarWChar
  $integer = [System.Data.OleDb.OleDbType]::Integer
  $date = [System.Data.OleDb.OleDbType]::Date
  $boolean = [System.Data.OleDb.OleDbType]::Boolean

  if ($Mode -eq 'MjSystem26') {
    $before = [int](Scalar $connection $transaction 'SELECT COUNT(*) FROM Employee WHERE vCardNo=? OR EmpMemo=?' @(,($string,$WgCardNo),($string,$marker)))
    if ($before -ne 0) { throw "Test card or marker already exists ($before)." }
    $empId = 'P' + (Get-Date -Format 'MMddHHmmss')
    [void](Execute $connection $transaction 'INSERT INTO Employee (vEmp_id,vEmp_name,vCardNo,vDepart,vDoorPassword,dBeginDate,dEndDate,EmpMemo,bWorkAttend) VALUES (?,?,?,?,?,?,?,?,?)' @(
      ,($string,$empId),($string,$marker),($string,$WgCardNo),($string,'PMS TEST BUILDING 26'),($string,'000000'),
      ($date,[datetime]'2000-01-01'),($date,[datetime]'2040-12-31'),($string,$marker),($boolean,$true)))
    $eId = [int](Scalar $connection $transaction 'SELECT @@IDENTITY' @())
    $doorIds = @('M0038-1', 'M0003-1', 'M0030-1')
    foreach ($doorId in $doorIds) {
      [void](Execute $connection $transaction 'INSERT INTO MJ_MacPower (cCardNo,cDoorId,cTimeId) VALUES (?,?,?)' @(,($string,$WgCardNo),($string,$doorId),($integer,1)))
    }
    $afterInsert = [int](Scalar $connection $transaction 'SELECT COUNT(*) FROM Employee AS e INNER JOIN MJ_MacPower AS p ON e.vCardNo=p.cCardNo WHERE e.EId=? AND e.EmpMemo=? AND p.cDoorId IN (?,?,?)' @(,($integer,$eId),($string,$marker),($string,$doorIds[0]),($string,$doorIds[1]),($string,$doorIds[2])))
    if ($afterInsert -ne 3) { throw "Insert verification failed ($afterInsert)." }
    $ids = @{ employeeEId = $eId; employeeId = $empId; doorIds = $doorIds }
    if (-not $Keep) {
      if ((Execute $connection $transaction 'DELETE FROM MJ_MacPower WHERE cCardNo=? AND cDoorId IN (?,?,?)' @(,($string,$WgCardNo),($string,$doorIds[0]),($string,$doorIds[1]),($string,$doorIds[2]))) -ne 3) { throw 'Expected to delete three permissions.' }
      if ((Execute $connection $transaction 'DELETE FROM Employee WHERE EId=? AND EmpMemo=? AND vCardNo=?' @(,($integer,$eId),($string,$marker),($string,$WgCardNo))) -ne 1) { throw 'Expected to delete one employee.' }
      $afterDelete = [int](Scalar $connection $transaction 'SELECT COUNT(*) FROM Employee WHERE EId=? OR vCardNo=?' @(,($integer,$eId),($string,$WgCardNo)))
    }
  }
  else {
    $before = [int](Scalar $connection $transaction 'SELECT COUNT(*) FROM t_b_IDCard WHERE f_CardNO=?' @(,($string,$WgCardNo)))
    if ($before -ne 0) { throw "Test card already exists ($before)." }
    $consumerNo = [int](Scalar $connection $transaction 'SELECT MAX(f_ConsumerNO) FROM t_b_Consumer' @()) + 1
    [void](Execute $connection $transaction 'INSERT INTO t_b_Consumer (f_ConsumerNO,f_ConsumerName,f_ConsumerGrade,f_GroupID,f_AttendEnabled,f_DoorEnabled,f_BeginYMD,f_EndYMD,f_Note,f_PatrolEnabled,f_bShift) VALUES (?,?,?,?,?,?,?,?,?,?,?)' @(
      ,($integer,$consumerNo),($string,$marker),($string,'0'),($integer,11),($integer,1),($integer,1),
      ($date,[datetime]'2000-01-01'),($date,[datetime]'2040-12-31'),($string,$marker),($integer,0),($integer,0)))
    $consumerId = [int](Scalar $connection $transaction 'SELECT @@IDENTITY' @())
    [void](Execute $connection $transaction 'INSERT INTO t_b_IDCard (f_CardNO,f_CardStatusDesc,f_ConsumerID) VALUES (?,?,?)' @(,($string,$WgCardNo),($string,'0'),($integer,$consumerId)))
    $cardId = [int](Scalar $connection $transaction 'SELECT @@IDENTITY' @())
    [void](Execute $connection $transaction 'INSERT INTO t_d_Privilege (f_DoorID,f_ControlSegID,f_ConsumerID) VALUES (?,?,?)' @(,($integer,26),($integer,1),($integer,$consumerId)))
    $privilegeId = [int](Scalar $connection $transaction 'SELECT @@IDENTITY' @())
    $afterInsert = [int](Scalar $connection $transaction 'SELECT COUNT(*) FROM (t_b_Consumer AS c INNER JOIN t_b_IDCard AS i ON c.f_ConsumerID=i.f_ConsumerID) INNER JOIN t_d_Privilege AS p ON c.f_ConsumerID=p.f_ConsumerID WHERE c.f_ConsumerID=? AND c.f_Note=? AND i.f_CardID=? AND i.f_CardNO=? AND p.f_RecID=? AND p.f_DoorID=?' @(
      ,($integer,$consumerId),($string,$marker),($integer,$cardId),($string,$WgCardNo),($integer,$privilegeId),($integer,26)))
    if ($afterInsert -ne 1) { throw "Insert verification failed ($afterInsert)." }
    $ids = @{ consumerId = $consumerId; consumerNo = $consumerNo; cardId = $cardId; privilegeId = $privilegeId; doorId = 26 }
    if (-not $Keep) {
      if ((Execute $connection $transaction 'DELETE FROM t_d_Privilege WHERE f_RecID=? AND f_ConsumerID=?' @(,($integer,$privilegeId),($integer,$consumerId))) -ne 1) { throw 'Expected to delete one privilege.' }
      if ((Execute $connection $transaction 'DELETE FROM t_b_IDCard WHERE f_CardID=? AND f_ConsumerID=? AND f_CardNO=?' @(,($integer,$cardId),($integer,$consumerId),($string,$WgCardNo))) -ne 1) { throw 'Expected to delete one card.' }
      if ((Execute $connection $transaction 'DELETE FROM t_b_Consumer WHERE f_ConsumerID=? AND f_Note=?' @(,($integer,$consumerId),($string,$marker))) -ne 1) { throw 'Expected to delete one consumer.' }
      $afterDelete = [int](Scalar $connection $transaction 'SELECT COUNT(*) FROM t_b_Consumer WHERE f_ConsumerID=? OR f_Note=?' @(,($integer,$consumerId),($string,$marker)))
    }
  }

  $transaction.Commit()
  [pscustomobject]@{
    mode = $Mode
    marker = $marker
    card = $WgCardNo
    before = $before
    afterInsert = $afterInsert
    kept = [bool]$Keep
    afterDelete = $afterDelete
    ids = $ids
  } | ConvertTo-Json -Depth 4
}
catch {
  try { $transaction.Rollback() } catch { }
  throw
}
finally { $connection.Close() }
