param(
  [Parameter(Mandatory = $true)][string]$Path,
  [string]$Password = '',
  [string]$Provider = 'Microsoft.Jet.OLEDB.4.0',
  [string]$ConnectionConfigPath = '',
  [string]$ConnectionConfigKey = 'dbConnection',
  [string]$OutputPath = ''
)

$ErrorActionPreference = 'Stop'
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
  $value.Provider = $Provider
  if ($Password) { $value['Jet OLEDB:Database Password'] = $Password }
  $value
}
$builder['Data Source'] = $Path
$connection = New-Object System.Data.OleDb.OleDbConnection($builder.ConnectionString)
$connection.Open()
try {
  $tables = $connection.GetSchema('Tables') | Where-Object { $_.TABLE_TYPE -eq 'TABLE' }
  $allColumns = $connection.GetSchema('Columns')
  $result = foreach ($table in $tables) {
    $name = [string]$table.TABLE_NAME
    $columns = $allColumns | Where-Object { [string]$_.TABLE_NAME -eq $name } | Sort-Object ORDINAL_POSITION | ForEach-Object {
      [pscustomobject]@{
        name = [string]$_.COLUMN_NAME
        ordinal = [int]$_.ORDINAL_POSITION
        type = [int]$_.DATA_TYPE
        nullable = [bool]$_.IS_NULLABLE
        maxLength = if ($_.CHARACTER_MAXIMUM_LENGTH -is [System.DBNull]) { $null } else { [int]$_.CHARACTER_MAXIMUM_LENGTH }
      }
    }
    $count = $null
    try {
      $command = $connection.CreateCommand()
      $command.CommandText = 'SELECT COUNT(*) FROM [' + $name.Replace(']', ']]') + ']'
      $count = [int64]$command.ExecuteScalar()
    } catch { }
    [pscustomobject]@{ table = $name; count = $count; columns = @($columns) }
  }
  $json = @($result) | ConvertTo-Json -Depth 6
  if ($OutputPath) { [IO.File]::WriteAllText($OutputPath, $json, [Text.UTF8Encoding]::new($false)) }
  else { $json }
}
finally { $connection.Close() }
