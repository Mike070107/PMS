#!/bin/bash

#############################################
# MySQL备份脚本安装配置脚本
# 用途：在Web服务器上安装配置MySQL备份任务
#############################################

echo "=========================================="
echo "MySQL 7天循环备份脚本 - 安装配置"
echo "=========================================="
echo ""

# 检查是否以root用户运行
if [ "$(id -u)" -ne 0 ]; then
    echo "错误: 请使用root用户运行此脚本"
    echo "使用方法: sudo bash install_mysql_backup.sh"
    exit 1
fi

# 安装必要的工具
echo "1. 检查并安装必要的工具..."

# 检查mysql-client
if ! command -v mysqldump &> /dev/null; then
    echo "   安装 mysql-client..."
    yum install -y mysql || dnf install -y mysql
fi

# 检查sshpass（如果需要远程备份）
if ! command -v sshpass &> /dev/null; then
    echo "   安装 sshpass..."
    yum install -y sshpass || dnf install -y sshpass
fi

echo "   工具检查完成"
echo ""

# 创建备份目录
echo "2. 创建备份目录..."
BACKUP_BASE_DIR="/var/www/MySQLBackup"
mkdir -p "${BACKUP_BASE_DIR}"/{full,incremental,logs}
chmod 700 "${BACKUP_BASE_DIR}"
echo "   备份目录创建完成: ${BACKUP_BASE_DIR}"
echo ""

# 复制备份脚本
echo "3. 安装备份脚本..."
SCRIPT_DIR="/usr/local/bin"
SCRIPT_NAME="mysql_backup.sh"

if [ -f "./mysql_backup.sh" ]; then
    cp ./mysql_backup.sh "${SCRIPT_DIR}/${SCRIPT_NAME}"
    chmod +x "${SCRIPT_DIR}/${SCRIPT_NAME}"
    echo "   备份脚本已安装到: ${SCRIPT_DIR}/${SCRIPT_NAME}"
else
    echo "   错误: 找不到 mysql_backup.sh 文件"
    exit 1
fi
echo ""

# 测试数据库连接
echo "4. 测试数据库连接..."
DB_HOST="192.168.110.248"
DB_PORT="3306"
DB_USER="root"
DB_PASSWORD="WJWY-User!2025"
DB_NAME="wjwy"

mysql -h"${DB_HOST}" -P"${DB_PORT}" -u"${DB_USER}" -p"${DB_PASSWORD}" -e "SELECT 1;" 2>/dev/null

if [ $? -eq 0 ]; then
    echo "   ✓ 数据库连接成功"
else
    echo "   ✗ 数据库连接失败，请检查配置"
    echo "   提示: 请确保Web服务器可以访问数据库服务器 ${DB_HOST}:${DB_PORT}"
fi
echo ""

# 配置定时任务
echo "5. 配置定时任务（crontab）..."

# 检查是否已存在相同的定时任务
if crontab -l 2>/dev/null | grep -q "${SCRIPT_NAME}"; then
    echo "   定时任务已存在，跳过配置"
else
    # 添加定时任务：每天凌晨2点执行
    (crontab -l 2>/dev/null; echo "0 2 * * * ${SCRIPT_DIR}/${SCRIPT_NAME} >> ${BACKUP_BASE_DIR}/logs/cron.log 2>&1") | crontab -
    echo "   ✓ 定时任务已添加（每天凌晨2点执行）"
fi

echo ""
echo "当前的定时任务列表:"
crontab -l | grep -v "^#"
echo ""

# 执行测试备份
echo "6. 执行测试备份..."
read -p "   是否立即执行一次测试备份？(y/n): " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "   执行测试备份中..."
    "${SCRIPT_DIR}/${SCRIPT_NAME}"
    
    echo ""
    echo "   备份结果:"
    ls -lh "${BACKUP_BASE_DIR}/full/" 2>/dev/null
    ls -lh "${BACKUP_BASE_DIR}/incremental/" 2>/dev/null
    echo ""
    echo "   最新日志:"
    tail -n 20 "${BACKUP_BASE_DIR}/logs/"backup_*.log 2>/dev/null | tail -n 20
fi

echo ""
echo "=========================================="
echo "安装配置完成！"
echo "=========================================="
echo ""
echo "重要信息："
echo "1. 备份脚本位置: ${SCRIPT_DIR}/${SCRIPT_NAME}"
echo "2. 备份目录: ${BACKUP_BASE_DIR}"
echo "3. 执行时间: 每天凌晨2点自动执行"
echo "4. 备份策略:"
echo "   - 星期一至星期六: 增量备份"
echo "   - 星期日: 全量备份"
echo ""
echo "手动执行备份："
echo "   ${SCRIPT_DIR}/${SCRIPT_NAME}"
echo ""
echo "查看备份日志："
echo "   tail -f ${BACKUP_BASE_DIR}/logs/backup_\$(date +%Y%m%d).log"
echo ""
echo "查看定时任务："
echo "   crontab -l"
echo ""
echo "修改定时任务："
echo "   crontab -e"
echo ""
