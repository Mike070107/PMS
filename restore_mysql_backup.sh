#!/bin/bash

#############################################
# MySQL备份恢复脚本
# 用途：从备份文件恢复MySQL数据库
#############################################

# 数据库配置
DB_USER="root"
DB_PASSWORD="WJWY-User!2025"
DB_HOST="192.168.110.248"
DB_PORT="3306"
DB_NAME="wjwy"

# 备份目录配置
BACKUP_BASE_DIR="/var/www/MySQLBackup"
FULL_BACKUP_DIR="${BACKUP_BASE_DIR}/full"
INC_BACKUP_DIR="${BACKUP_BASE_DIR}/incremental"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "=========================================="
echo "MySQL数据库恢复工具"
echo "=========================================="
echo ""

# 列出可用的全量备份
echo "可用的全量备份文件："
echo ""
FULL_BACKUPS=($(ls -t "${FULL_BACKUP_DIR}"/full_backup_day7_*.sql.gz 2>/dev/null))

if [ ${#FULL_BACKUPS[@]} -eq 0 ]; then
    echo -e "${RED}错误: 未找到任何全量备份文件${NC}"
    exit 1
fi

for i in "${!FULL_BACKUPS[@]}"; do
    backup_file="${FULL_BACKUPS[$i]}"
    file_size=$(du -h "$backup_file" | awk '{print $1}')
    file_date=$(stat -c %y "$backup_file" | cut -d' ' -f1)
    echo "[$i] $(basename $backup_file) - 大小: ${file_size}, 日期: ${file_date}"
done

echo ""
read -p "请选择要恢复的全量备份编号 (0-$((${#FULL_BACKUPS[@]}-1))): " backup_index

if ! [[ "$backup_index" =~ ^[0-9]+$ ]] || [ "$backup_index" -ge ${#FULL_BACKUPS[@]} ]; then
    echo -e "${RED}错误: 无效的备份编号${NC}"
    exit 1
fi

SELECTED_BACKUP="${FULL_BACKUPS[$backup_index]}"
echo ""
echo -e "${GREEN}已选择: $(basename $SELECTED_BACKUP)${NC}"
echo ""

# 检查是否需要恢复增量备份
echo "可用的增量备份："
echo ""
INC_BACKUPS=($(find "${INC_BACKUP_DIR}" -name "inc_backup_*.sql.gz" 2>/dev/null | sort))

if [ ${#INC_BACKUPS[@]} -gt 0 ]; then
    echo "找到 ${#INC_BACKUPS[@]} 个增量备份文件"
    for i in "${!INC_BACKUPS[@]}"; do
        backup_file="${INC_BACKUPS[$i]}"
        file_size=$(du -h "$backup_file" | awk '{print $1}')
        file_date=$(stat -c %y "$backup_file" | cut -d' ' -f1)
        echo "  [$i] $(basename $backup_file) - 大小: ${file_size}, 日期: ${file_date}"
    done
    echo ""
    read -p "是否也恢复增量备份？(y/n): " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        INC_BACKUPS=()
    fi
else
    echo "未找到增量备份文件"
fi

echo ""
echo -e "${YELLOW}警告: 此操作将覆盖数据库 ${DB_NAME} 的所有数据！${NC}"
echo ""
read -p "确定要继续吗？请输入 'YES' 确认: " confirm

if [ "$confirm" != "YES" ]; then
    echo "操作已取消"
    exit 0
fi

echo ""
echo "=========================================="
echo "开始恢复数据库..."
echo "=========================================="

# 创建临时目录
TEMP_DIR="/tmp/mysql_restore_$$"
mkdir -p "${TEMP_DIR}"

# 解压全量备份
echo ""
echo "1. 解压全量备份文件..."
TEMP_SQL="${TEMP_DIR}/full_backup.sql"
gunzip -c "${SELECTED_BACKUP}" > "${TEMP_SQL}"

if [ $? -ne 0 ]; then
    echo -e "${RED}错误: 解压全量备份失败${NC}"
    rm -rf "${TEMP_DIR}"
    exit 1
fi

echo -e "${GREEN}   ✓ 全量备份解压成功${NC}"

# 恢复全量备份
echo ""
echo "2. 恢复全量备份到数据库..."
mysql -h"${DB_HOST}" \
      -P"${DB_PORT}" \
      -u"${DB_USER}" \
      -p"${DB_PASSWORD}" \
      < "${TEMP_SQL}" 2>&1

if [ $? -eq 0 ]; then
    echo -e "${GREEN}   ✓ 全量备份恢复成功${NC}"
else
    echo -e "${RED}   ✗ 全量备份恢复失败${NC}"
    rm -rf "${TEMP_DIR}"
    exit 1
fi

# 恢复增量备份
if [ ${#INC_BACKUPS[@]} -gt 0 ]; then
    echo ""
    echo "3. 恢复增量备份..."
    
    for inc_backup in "${INC_BACKUPS[@]}"; do
        echo "   恢复: $(basename $inc_backup)"
        
        INC_TEMP_SQL="${TEMP_DIR}/inc_backup_temp.sql"
        gunzip -c "${inc_backup}" > "${INC_TEMP_SQL}"
        
        mysql -h"${DB_HOST}" \
              -P"${DB_PORT}" \
              -u"${DB_USER}" \
              -p"${DB_PASSWORD}" \
              < "${INC_TEMP_SQL}" 2>&1
        
        if [ $? -eq 0 ]; then
            echo -e "${GREEN}   ✓ 增量备份恢复成功${NC}"
        else
            echo -e "${RED}   ✗ 增量备份恢复失败${NC}"
        fi
        
        rm -f "${INC_TEMP_SQL}"
    done
fi

# 清理临时文件
echo ""
echo "4. 清理临时文件..."
rm -rf "${TEMP_DIR}"
echo -e "${GREEN}   ✓ 临时文件已清理${NC}"

echo ""
echo "=========================================="
echo -e "${GREEN}数据库恢复完成！${NC}"
echo "=========================================="
echo ""
echo "恢复信息："
echo "  - 数据库: ${DB_NAME}"
echo "  - 服务器: ${DB_HOST}:${DB_PORT}"
echo "  - 全量备份: $(basename $SELECTED_BACKUP)"
echo "  - 增量备份: ${#INC_BACKUPS[@]} 个文件"
echo ""
echo "建议："
echo "1. 检查数据完整性"
echo "2. 测试应用功能"
echo "3. 查看数据库日志"
echo ""

exit 0
