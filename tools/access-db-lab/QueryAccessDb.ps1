param(
  [Parameter(Mandatory = $true)][string]$Path,
  [Parameter(Mandatory = $true)][string]$Sql,
  [string]$ConnectionConfigPath = '',
  [string]$ConnectionConfigKey = 'dbConnection',
  [string]$OutputPath = ''
)

$ErrorActionPreference = 'Stop'
if ($Sql -notmatch '^\s*(SELECT|TRANSFORM)\b') {
  throw 'This inspection utility only permits SELECT/TRANSFORM statements.'
}

$builder = if ($ConnectionConfigPath) {
  [xml]$config = Get-Content -LiteralPath $ConnectionConfigPath
  $configured = @($config.configuration.appSettings.add) |
    Where-Object { $_.key -eq $ConnectionConfigKey } |
    Select-Object -First 1
  if (-not $configured -or -not $configured.value) {
    throw "Connection string key '$ConnectionConfigKey' was not found."
  }
  New-Object System.Data.OleDb.OleDbConnectionStringBuilder([string]$configured.value)
}
else {
  $value = New-Object System.Data.OleDb.OleDbConnectionStringBuilder
  $value.Provider = 'Microsoft.Jet.OLEDB.4.0'
  $value
}
$builder['Data Source'] = $Path

$connection = New-Object System.Data.OleDb.OleDbConnection($builder.ConnectionString)
$connection.Open()
try {
  $command = $connection.CreateCommand()
  $command.CommandText = $Sql
  $adapter = New-Object System.Data.OleDb.OleDbDataAdapter($command)
  $table = New-Object System.Data.DataTable
  [void]$adapter.Fill($table)
  $rows = foreach ($row in $table.Rows) {
    $item = [ordered]@{}
    foreach ($column in $table.Columns) {
      $value = $row[$column]
      $item[$column.ColumnName] = if ($value -is [DBNull]) { $null } else { $value }
    }
    [pscustomobject]$item
  }
  $json = @($rows) | ConvertTo-Json -Depth 5
  if ($OutputPath) { [IO.File]::WriteAllText($OutputPath, $json, [Text.UTF8Encoding]::new($false)) }
  else { $json }
}
finally { $connection.Close() }
