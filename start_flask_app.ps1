# PowerShell脚本用于启动Flask应用
$password = "abc.123"
$server = "192.168.1.251"
$sshKey = "C:\Users\Administrator\.ssh\id_rsa_wjwy"

# 创建SSH连接并执行启动命令
$commands = @(
    "cd /var/www/web_app",
    "pkill -f 'python3 app.py'",
    "source venv/bin/activate",
    "python3 app.py"
)

$commandString = $commands -join " && "

# 使用sshpass工具传递密码（如果可用）
# 或者使用expect工具（如果可用）
# 这里使用简单的echo方法
try {
    Write-Host "正在连接到服务器 $server..."
    $result = echo $password | ssh -o StrictHostKeyChecking=no -i $sshKey root@$server $commandString
    Write-Host "命令执行结果: $result"
} catch {
    Write-Host "连接失败，请检查网络连接和服务器状态"
    Write-Host "错误信息: $_"
}