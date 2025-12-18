function Connect-Server {
    param(
        [string]$Server = "192.168.1.251",
        [string]$User = "root",
        [string]$Password = "abc.123",
        [string]$Command = ""
    )
    
    # 创建密码对象
    $securePassword = ConvertTo-SecureString $Password -AsPlainText -Force
    $credential = New-Object System.Management.Automation.PSCredential($User, $securePassword)
    
    if ($Command) {
        # 执行远程命令
        $sshCommand = "ssh -o StrictHostKeyChecking=no -o PasswordAuthentication=yes $User@$Server `"$Command`""
        # 由于SSH需要交互式输入密码，我们使用expect的替代方案
        $result = cmd /c "echo $Password | ssh -o StrictHostKeyChecking=no $User@$Server `"$Command`""
        return $result
    } else {
        # 交互式连接
        ssh -o StrictHostKeyChecking=no $User@$Server
    }
}

# 导出函数
Export-ModuleMember -Function Connect-Server