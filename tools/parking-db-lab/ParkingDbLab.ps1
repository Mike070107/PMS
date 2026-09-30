param(
  [Parameter(Mandatory = $true)][ValidateSet('Inspect', 'Analyze', 'Backup')][string]$Operation,
  [Parameter(Mandatory = $true)][string]$DsnPath,
  [Parameter(Mandatory = $true)][ValidateSet('parking1', 'parking2')][string]$Database,
  [string]$LocalBackupDirectory = 'D:\PMS-Parking-Backups'
)

$ErrorActionPreference = 'Stop'

function Read-IniSection([string]$path, [string]$section) {
  $inside = $false
  $values = @{}
  foreach ($line in Get-Content -LiteralPath $path) {
    $trimmed = $line.Trim()
    if ($trimmed -match '^\[(.+)\]$') {
      $inside = $matches[1] -eq $section
      continue
    }
    if ($inside -and $trimmed -match '^([^=]+)=(.*)$') {
      $values[$matches[1].Trim()] = $matches[2].Trim()
    }
  }
  return $values
}

function Open-Connection([string]$catalog) {
  $settings = Read-IniSection $DsnPath 'DBsystem'
  foreach ($key in @('Server', 'Sa', 'Pa')) {
    if (-not $settings.ContainsKey($key) -or -not $settings[$key]) { throw "Missing DBsystem/$key in dsn.ini." }
  }
  $builder = New-Object System.Data.SqlClient.SqlConnectionStringBuilder
  $builder['Data Source'] = $settings.Server
  $builder['Initial Catalog'] = $catalog
  $builder['User ID'] = $settings.Sa
  $builder['Password'] = $settings.Pa
  $builder['Connect Timeout'] = 10
  $builder['Encrypt'] = $false
  $builder['Application Name'] = 'PMS Parking Lab'
  $connection = New-Object System.Data.SqlClient.SqlConnection($builder.ConnectionString)
  $connection.Open()
  return $connection
}

function Query-Table($connection, [string]$sql) {
  $command = $connection.CreateCommand()
  $command.CommandText = $sql
  $command.CommandTimeout = 30
  $adapter = New-Object System.Data.SqlClient.SqlDataAdapter($command)
  $table = New-Object System.Data.DataTable
  [void]$adapter.Fill($table)
  return $table
}

if ($Operation -eq 'Inspect' -or $Operation -eq 'Analyze') {
  $connection = Open-Connection $Database
  try {
    $sql = if ($Operation -eq 'Analyze') { @"
SELECT p.[name] AS procedure_name, OBJECT_DEFINITION(p.object_id) AS definition
FROM sys.procedures p
WHERE p.[name] IN ('AddIssue','Palte_extend','Up_PakIssue','Add_Del_Plate','Add_DownloadCard','Add_Release','Get_Download')
ORDER BY p.[name];

SELECT t.[name] AS table_name, c.column_id, c.[name] AS column_name,
       TYPE_NAME(c.user_type_id) AS type_name, c.max_length, c.is_nullable
FROM sys.tables t
JOIN sys.columns c ON c.object_id=t.object_id
WHERE t.[name] IN ('Car_Issue','Car_Download','Car_Release','Owner_Issue')
ORDER BY t.[name], c.column_id;
"@ } else { @"
SELECT DB_NAME() AS database_name,
       CAST(SUM(size) * 8.0 / 1024 AS DECIMAL(18,2)) AS database_size_mb,
       HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'BACKUP DATABASE') AS can_backup
FROM sys.database_files;

SELECT p.[name] AS procedure_name,
       prm.parameter_id,
       prm.[name] AS parameter_name,
       TYPE_NAME(prm.user_type_id) AS type_name,
       prm.max_length,
       prm.is_output
FROM sys.procedures p
LEFT JOIN sys.parameters prm ON prm.object_id = p.object_id
WHERE p.[name] IN ('AddIssue','Palte_extend','Up_PakIssue','Add_Del_Plate','Add_DownloadCard','Add_Release','Get_Download')
ORDER BY p.[name], prm.parameter_id;
"@
    }
    $command = $connection.CreateCommand()
    $command.CommandText = $sql
    $command.CommandTimeout = 30
    $reader = $command.ExecuteReader()
    if ($Operation -eq 'Analyze') {
      $definitions = @()
      while ($reader.Read()) {
        $definitions += [pscustomobject]@{ procedure = [string]$reader['procedure_name']; definition = [string]$reader['definition'] }
      }
      [void]$reader.NextResult()
      $columns = @()
      while ($reader.Read()) {
        $columns += [pscustomobject]@{
          table = [string]$reader['table_name']; ordinal = [int]$reader['column_id']; column = [string]$reader['column_name']
          type = [string]$reader['type_name']; maxLength = [int]$reader['max_length']; nullable = [bool]$reader['is_nullable']
        }
      }
      $reader.Close()
      [pscustomobject]@{ definitions = $definitions; columns = $columns } | ConvertTo-Json -Depth 5
      return
    }
    $summary = @()
    while ($reader.Read()) {
      $summary += [pscustomobject]@{
        database = [string]$reader['database_name']
        sizeMb = [decimal]$reader['database_size_mb']
        canBackup = [int]$reader['can_backup'] -eq 1
      }
    }
    [void]$reader.NextResult()
    $procedures = @()
    while ($reader.Read()) {
      $procedures += [pscustomobject]@{
        procedure = [string]$reader['procedure_name']
        ordinal = if ($reader['parameter_id'] -is [DBNull]) { $null } else { [int]$reader['parameter_id'] }
        parameter = if ($reader['parameter_name'] -is [DBNull]) { $null } else { [string]$reader['parameter_name'] }
        type = if ($reader['type_name'] -is [DBNull]) { $null } else { [string]$reader['type_name'] }
        maxLength = if ($reader['max_length'] -is [DBNull]) { $null } else { [int]$reader['max_length'] }
        output = if ($reader['is_output'] -is [DBNull]) { $false } else { [bool]$reader['is_output'] }
      }
    }
    $reader.Close()
    [pscustomobject]@{ summary = $summary; procedures = $procedures } | ConvertTo-Json -Depth 5
  }
  finally { $connection.Close() }
  exit
}

New-Item -ItemType Directory -Path $LocalBackupDirectory -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupName = "$Database-$stamp.bak"
$remotePath = "D:\PMS-Parking-Backups\$backupName"
$localPath = Join-Path $LocalBackupDirectory $backupName
$connection = Open-Connection 'master'
try {
  $createDirectory = $connection.CreateCommand()
  $createDirectory.CommandText = 'EXEC master.dbo.xp_create_subdir @directory;'
  [void]$createDirectory.Parameters.Add('@directory', [Data.SqlDbType]::NVarChar, 4000)
  $createDirectory.Parameters['@directory'].Value = 'D:\PMS-Parking-Backups'
  [void]$createDirectory.ExecuteNonQuery()

  $command = $connection.CreateCommand()
  $command.CommandText = "BACKUP DATABASE [$Database] TO DISK = @path WITH COPY_ONLY, CHECKSUM, COMPRESSION, INIT; RESTORE VERIFYONLY FROM DISK = @path WITH CHECKSUM;"
  [void]$command.Parameters.Add('@path', [Data.SqlDbType]::NVarChar, 4000)
  $command.Parameters['@path'].Value = $remotePath
  $command.CommandTimeout = 600
  [void]$command.ExecuteNonQuery()

  $read = $connection.CreateCommand()
  $escaped = $remotePath.Replace("'", "''")
  $read.CommandText = "SELECT BulkColumn FROM OPENROWSET(BULK N'$escaped', SINGLE_BLOB) AS backup_file;"
  $read.CommandTimeout = 600
  $reader = $read.ExecuteReader([Data.CommandBehavior]::SequentialAccess)
  if (-not $reader.Read()) { throw 'SQL Server did not return the backup stream.' }
  $stream = $reader.GetStream(0)
  $file = [IO.File]::Open($localPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $stream.CopyTo($file) } finally { $file.Close(); $stream.Close(); $reader.Close() }
  $item = Get-Item -LiteralPath $localPath
  [pscustomobject]@{
    database = $Database
    localPath = $item.FullName
    remotePath = $remotePath
    bytes = $item.Length
    sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $item.FullName).Hash
    verifiedBySqlServer = $true
  } | ConvertTo-Json -Compress
}
finally { $connection.Close() }
