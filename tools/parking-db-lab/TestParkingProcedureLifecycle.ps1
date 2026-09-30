param(
  [Parameter(Mandatory = $true)][string]$DsnPath,
  [Parameter(Mandatory = $true)][ValidateSet('parking1', 'parking2')][string]$Database
)

$ErrorActionPreference = 'Stop'

function Read-IniSection([string]$path, [string]$section) {
  $inside = $false
  $values = @{}
  foreach ($line in Get-Content -LiteralPath $path) {
    $trimmed = $line.Trim()
    if ($trimmed -match '^\[(.+)\]$') { $inside = $matches[1] -eq $section; continue }
    if ($inside -and $trimmed -match '^([^=]+)=(.*)$') { $values[$matches[1].Trim()] = $matches[2].Trim() }
  }
  return $values
}

function Add-Value($command, [string]$name, $type, [int]$size, $value) {
  $parameter = if ($size -gt 0) { $command.Parameters.Add($name, $type, $size) } else { $command.Parameters.Add($name, $type) }
  $parameter.Value = $value
}

function Scalar($connection, [string]$sql, [hashtable]$values) {
  $command = $connection.CreateCommand()
  $command.CommandText = $sql
  foreach ($entry in $values.GetEnumerator()) { [void]$command.Parameters.AddWithValue($entry.Key, $entry.Value) }
  return $command.ExecuteScalar()
}

function Execute($connection, [string]$sql, [hashtable]$values) {
  $command = $connection.CreateCommand()
  $command.CommandText = $sql
  foreach ($entry in $values.GetEnumerator()) { [void]$command.Parameters.AddWithValue($entry.Key, $entry.Value) }
  return $command.ExecuteNonQuery()
}

$settings = Read-IniSection $DsnPath 'DBsystem'
$builder = New-Object System.Data.SqlClient.SqlConnectionStringBuilder
$builder['Data Source'] = $settings.Server
$builder['Initial Catalog'] = $Database
$builder['User ID'] = $settings.Sa
$builder['Password'] = $settings.Pa
$builder['Connect Timeout'] = 10
$builder['Encrypt'] = $false
$builder['Application Name'] = 'PMS Parking Procedure Test'
$connection = New-Object System.Data.SqlClient.SqlConnection($builder.ConnectionString)
$connection.Open()

$stamp = Get-Date -Format 'MMddHHmmss'
$ownerName = "PMS_T_$stamp"
$originalPlate = if ($Database -eq 'parking1') { "PMS1$stamp" } else { "PMS2$stamp" }
$changedPlate = if ($Database -eq 'parking1') { "PMSA$stamp" } else { "PMSB$stamp" }
$admin = 'PMS_TEST'
$note = "PMS_TEST_$stamp; source=PMS"
$effective = New-Object char[] 256
$download = New-Object char[] 256
for ($index = 0; $index -lt 256; $index++) { $effective[$index] = '0'; $download[$index] = '0' }
$channels = if ($Database -eq 'parking1') { @(5, 7) } else { @(9, 11, 13) }
foreach ($channel in $channels) { $effective[$channel - 1] = '1' }
$effectiveText = New-Object string (,$effective)
$downloadText = New-Object string (,$download)
$beginDate = (Get-Date).Date
$firstEndDate = $beginDate.AddMonths(1)
$renewedEndDate = $beginDate.AddMonths(2)
$ownerId = $null
$issueId = $null
$moneyId = $null
$changeId = $null

try {
  $preexisting = [int](Scalar $connection 'SELECT COUNT(*) FROM Car_Issue WHERE P_plate IN (@old,@new);' @{ '@old'=$originalPlate; '@new'=$changedPlate })
  if ($preexisting -ne 0) { throw 'Generated test plate already exists.' }

  $add = $connection.CreateCommand()
  $add.CommandType = [Data.CommandType]::StoredProcedure
  $add.CommandText = 'dbo.AddIssue'
  Add-Value $add '@owner_Name' ([Data.SqlDbType]::VarChar) 20 $ownerName
  Add-Value $add '@owner_Add' ([Data.SqlDbType]::VarChar) 80 'PMS TEST'
  Add-Value $add '@owner_Tel' ([Data.SqlDbType]::VarChar) 80 ''
  Add-Value $add '@owner_Sex' ([Data.SqlDbType]::Int) 0 0
  Add-Value $add '@owner_depa' ([Data.SqlDbType]::VarChar) 50 'PMS'
  Add-Value $add '@Owner_Image' ([Data.SqlDbType]::VarChar) 80 ''
  Add-Value $add '@P_plate' ([Data.SqlDbType]::VarChar) 50 $originalPlate
  Add-Value $add '@P_Color' ([Data.SqlDbType]::VarChar) 10 'TEST'
  Add-Value $add '@Car_Lei' ([Data.SqlDbType]::Int) 0 1
  Add-Value $add '@Sart_Time' ([Data.SqlDbType]::DateTime) 0 $beginDate
  Add-Value $add '@End_Time' ([Data.SqlDbType]::DateTime) 0 $firstEndDate
  Add-Value $add '@Car_ID' ([Data.SqlDbType]::VarChar) 20 '0000000000'
  Add-Value $add '@Car_Brand' ([Data.SqlDbType]::VarChar) 20 'PMS_TEST'
  Add-Value $add '@Car_Money' ([Data.SqlDbType]::Float) 0 0
  Add-Value $add '@Car_Deposit' ([Data.SqlDbType]::Float) 0 0
  Add-Value $add '@Car_Zt' ([Data.SqlDbType]::Int) 0 1
  Add-Value $add '@P_note' ([Data.SqlDbType]::VarChar) 200 $note
  Add-Value $add '@P_Admin' ([Data.SqlDbType]::VarChar) 20 $admin
  Add-Value $add '@P_Spaces' ([Data.SqlDbType]::VarChar) 20 'PMS-TEST'
  Add-Value $add '@P_Effective' ([Data.SqlDbType]::VarChar) 256 $effectiveText
  Add-Value $add '@P_Download' ([Data.SqlDbType]::VarChar) 256 $downloadText
  [void]$add.ExecuteNonQuery()

  $ownerId = [int](Scalar $connection 'SELECT UserID FROM P_Owner WHERE owner_Name=@owner;' @{ '@owner'=$ownerName })
  $issueId = [int](Scalar $connection 'SELECT P_id FROM Car_Issue WHERE P_plate=@plate AND Owner_ID=@ownerId AND P_note=@note;' @{ '@plate'=$originalPlate; '@ownerId'=$ownerId; '@note'=$note })
  if ($issueId -le 0) { throw 'AddIssue did not create the expected vehicle row.' }

  $renew = $connection.CreateCommand()
  $renew.CommandType = [Data.CommandType]::StoredProcedure
  $renew.CommandText = 'dbo.Palte_extend'
  Add-Value $renew '@P_plate' ([Data.SqlDbType]::VarChar) 50 $originalPlate
  Add-Value $renew '@type' ([Data.SqlDbType]::Int) 0 5
  Add-Value $renew '@P_money' ([Data.SqlDbType]::Float) 0 0
  Add-Value $renew '@End_Time' ([Data.SqlDbType]::DateTime) 0 $renewedEndDate
  Add-Value $renew '@P_Admin' ([Data.SqlDbType]::VarChar) 20 $admin
  [void]$renew.ExecuteNonQuery()
  $moneyId = [int](Scalar $connection 'SELECT MAX(ID) FROM P_moneyKeep WHERE Issue_ID=@issueId AND P_plate=@plate AND type=5 AND P_Admin=@admin;' @{ '@issueId'=$issueId; '@plate'=$originalPlate; '@admin'=$admin })
  $storedEndDate = [datetime](Scalar $connection 'SELECT End_Time FROM Car_Issue WHERE P_id=@issueId;' @{ '@issueId'=$issueId })
  if ($storedEndDate.Date -ne $renewedEndDate.Date) { throw 'Palte_extend did not update End_Time.' }

  $change = $connection.CreateCommand()
  $change.CommandType = [Data.CommandType]::StoredProcedure
  $change.CommandText = 'dbo.Up_PakIssue'
  Add-Value $change '@Pak_plate' ([Data.SqlDbType]::VarChar) 50 $changedPlate
  Add-Value $change '@y_Pak_plate' ([Data.SqlDbType]::VarChar) 50 $originalPlate
  Add-Value $change '@P_Color' ([Data.SqlDbType]::VarChar) 10 'TEST'
  Add-Value $change '@Car_Lei' ([Data.SqlDbType]::Int) 0 1
  Add-Value $change '@owner_Name' ([Data.SqlDbType]::VarChar) 20 $ownerName
  Add-Value $change '@Car_Brand' ([Data.SqlDbType]::VarChar) 20 'PMS_TEST'
  Add-Value $change '@P_note' ([Data.SqlDbType]::VarChar) 200 $note
  Add-Value $change '@admin' ([Data.SqlDbType]::VarChar) 20 $admin
  Add-Value $change '@P_Spaces' ([Data.SqlDbType]::VarChar) 20 'PMS-TEST'
  Add-Value $change '@P_Effective' ([Data.SqlDbType]::VarChar) 256 $effectiveText
  Add-Value $change '@P_Download' ([Data.SqlDbType]::VarChar) 256 $downloadText
  [void]$change.ExecuteNonQuery()
  $changeId = [int](Scalar $connection 'SELECT MAX(P_id) FROM Up_Issue WHERE IssueID=@issueId AND y_P_plate=@old AND N_P_plate=@new AND Up_admin=@admin;' @{ '@issueId'=$issueId; '@old'=$originalPlate; '@new'=$changedPlate; '@admin'=$admin })
  if ([int](Scalar $connection 'SELECT COUNT(*) FROM Car_Issue WHERE P_id=@issueId AND P_plate=@new;' @{ '@issueId'=$issueId; '@new'=$changedPlate }) -ne 1) { throw 'Up_PakIssue did not change the plate.' }

  $delete = $connection.CreateCommand()
  $delete.CommandType = [Data.CommandType]::StoredProcedure
  $delete.CommandText = 'dbo.Add_Del_Plate'
  Add-Value $delete '@P_plate' ([Data.SqlDbType]::VarChar) 50 $changedPlate
  Add-Value $delete '@Up_moey' ([Data.SqlDbType]::Int) 0 0
  Add-Value $delete '@Up_Yajin' ([Data.SqlDbType]::Int) 0 0
  Add-Value $delete '@Admin' ([Data.SqlDbType]::VarChar) 20 $admin
  [void]$delete.ExecuteNonQuery()
  $afterDelete = [int](Scalar $connection 'SELECT COUNT(*) FROM Car_Issue WHERE P_id=@issueId OR P_plate IN (@old,@new);' @{ '@issueId'=$issueId; '@old'=$originalPlate; '@new'=$changedPlate })
  $cancelled = [int](Scalar $connection 'SELECT COUNT(*) FROM Car_cancellation WHERE P_id=@issueId AND P_plate=@new AND atino_admin=@admin;' @{ '@issueId'=$issueId; '@new'=$changedPlate; '@admin'=$admin })
  if ($afterDelete -ne 0 -or $cancelled -ne 1) { throw "Add_Del_Plate verification failed (active=$afterDelete cancelled=$cancelled)." }

  $cleanup = @()
  $cleanup += Execute $connection 'DELETE FROM Car_cancellation WHERE P_id=@issueId AND P_plate=@plate AND atino_admin=@admin;' @{ '@issueId'=$issueId; '@plate'=$changedPlate; '@admin'=$admin }
  $cleanup += Execute $connection 'DELETE FROM P_moneyKeep WHERE ID=@id AND Issue_ID=@issueId AND P_Admin=@admin;' @{ '@id'=$moneyId; '@issueId'=$issueId; '@admin'=$admin }
  $cleanup += Execute $connection 'DELETE FROM Up_Issue WHERE P_id=@id AND IssueID=@issueId AND Up_admin=@admin;' @{ '@id'=$changeId; '@issueId'=$issueId; '@admin'=$admin }
  $cleanup += Execute $connection 'DELETE FROM P_Owner WHERE UserID=@ownerId AND owner_Name=@owner AND NOT EXISTS (SELECT 1 FROM Car_Issue WHERE Owner_ID=@ownerId);' @{ '@ownerId'=$ownerId; '@owner'=$ownerName }
  if (($cleanup | Measure-Object -Sum).Sum -ne 4) { throw "Cleanup affected unexpected row counts: $($cleanup -join ',')." }

  $residue = [int](Scalar $connection @'
SELECT
 (SELECT COUNT(*) FROM Car_Issue WHERE P_id=@issueId OR P_plate IN (@old,@new)) +
 (SELECT COUNT(*) FROM Car_cancellation WHERE P_id=@issueId AND atino_admin=@admin) +
 (SELECT COUNT(*) FROM P_moneyKeep WHERE ID=@moneyId AND Issue_ID=@issueId) +
 (SELECT COUNT(*) FROM Up_Issue WHERE P_id=@changeId AND IssueID=@issueId) +
 (SELECT COUNT(*) FROM P_Owner WHERE UserID=@ownerId AND owner_Name=@owner);
'@ @{ '@issueId'=$issueId; '@old'=$originalPlate; '@new'=$changedPlate; '@admin'=$admin; '@moneyId'=$moneyId; '@changeId'=$changeId; '@ownerId'=$ownerId; '@owner'=$ownerName })
  if ($residue -ne 0) { throw "Test cleanup left $residue rows." }

  [pscustomobject]@{
    database = $Database; marker = $note; addIssueId = $issueId; ownerId = $ownerId
    renewalAuditId = $moneyId; changeAuditId = $changeId
    addVerified = $true; renewalVerified = $true; plateChangeVerified = $true
    cancellationVerified = $true; cleanupResidue = $residue; deviceQueueCreated = $false
  } | ConvertTo-Json -Compress
}
finally { $connection.Close() }
