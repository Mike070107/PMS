# Run in 32-bit Windows PowerShell after building the x86 assistant.
$ErrorActionPreference = 'Stop'
$dll = Resolve-Path "$PSScriptRoot/../data-sync-assistant-v2/bin/Release/Pms.DataSyncAssistant.V2.exe"
$assembly = [Reflection.Assembly]::LoadFrom($dll.Path)
$flags = [Reflection.BindingFlags]'Static,NonPublic'
$db = $assembly.GetType('Pms.AccessCardAgent.AccessGatewayDatabase', $true).GetMethod('IcCardDoors', $flags)
$upload = $assembly.GetTypes() | ForEach-Object { $_.GetMethod('IcCardDoor', $flags) } | Where-Object { $_ } | Select-Object -First 1
if (!$upload) { throw 'Missing controller upload resolver' }
$file = Join-Path ([IO.Path]::GetTempPath()) ("pms-door-" + [guid]::NewGuid() + ".mdb")
$cs = "Provider=Microsoft.Jet.OLEDB.4.0;Data Source=$file"
$catalog = New-Object -ComObject ADOX.Catalog
[void]$catalog.Create($cs)
$catalog.ActiveConnection.Close()
[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($catalog)
$conn = New-Object Data.OleDb.OleDbConnection($cs)
function ExecSql([string]$sql) {
    $cmd = $conn.CreateCommand()
    try { $cmd.CommandText = $sql; [void]$cmd.ExecuteNonQuery() } finally { $cmd.Dispose() }
}
function CheckDoors([bool]$ambiguous) {
    foreach ($method in @($db, $upload)) {
        $argsForMethod = if ($method -eq $db) { @($conn, $null, '45') } else { @($conn, '45') }
        $argsForMethod[0] = $conn.PSObject.BaseObject
        try { $result = $method.Invoke($null, $argsForMethod) } catch {
            if ($ambiguous -and $_.Exception.GetBaseException().Message -like '*唯一识别*') { continue }
            throw
        }
        if ($ambiguous -or @($result).Count -ne 1 -or [int]$result[0] -ne 22) { throw "Incorrect door: $result" }
    }
}
try {
    $conn.Open()
    ExecSql 'CREATE TABLE t_b_Controller (f_ControllerID LONG, f_ControllerName TEXT(60), f_Enabled INTEGER)'
    ExecSql 'CREATE TABLE t_b_Door (f_DoorID LONG, f_DoorName TEXT(60), f_ControllerID LONG)'
    ExecSql "INSERT INTO t_b_Controller VALUES (16,'45号大门',1)"
    ExecSql "INSERT INTO t_b_Door VALUES (1,'45号大门600001',600001)"
    ExecSql "INSERT INTO t_b_Door VALUES (22,'45号大门',16)"
    ExecSql "INSERT INTO t_b_Controller VALUES (18,'45号大门',0)"
    ExecSql "INSERT INTO t_b_Door VALUES (25,'45号大门停用',18)"
    ExecSql "UPDATE t_b_Door SET f_DoorName='设备一号' WHERE f_DoorID=22"
    ExecSql "INSERT INTO t_b_Controller VALUES (19,'46号大门',1)"
    ExecSql "INSERT INTO t_b_Door VALUES (27,'45号大门',19)"
    ExecSql "INSERT INTO t_b_Controller VALUES (20,'45号大门600001',1)"
    ExecSql "INSERT INTO t_b_Door VALUES (28,'历史门',20)"
    CheckDoors $false
    ExecSql "INSERT INTO t_b_Door VALUES (26,'45号大门侧门',16)"
    CheckDoors $true
    ExecSql "DELETE FROM t_b_Door WHERE f_DoorID=26"
    ExecSql "INSERT INTO t_b_Controller VALUES (21,'45号大门',1)"
    CheckDoors $true
    Write-Output 'PASS: writer and uploader resolve only the active door and reject ambiguous active doors.'
} finally {
    $conn.Dispose()
    [Data.OleDb.OleDbConnection]::ReleaseObjectPool()
    Remove-Item -LiteralPath $file -ErrorAction SilentlyContinue
}
