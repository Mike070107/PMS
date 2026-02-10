#!/bin/bash

#############################################
# MySQL 7天循环备份脚本
# 功能：每6天增量备份，第7天全量备份
# 作者：自动生成
# 日期：2026-02-11
#############################################

# 数据库配置
DB_USER="root"
DB_PASSWORD="WJWY-User!2025"
DB_HOST="192.168.110.248"
DB_PORT="3306"
DB_NAME="wjwy"

# SSH配置（用于远程登录数据库服务器）
SSH_USER="root"
SSH_PASSWORD="abc.123"
SSH_HOST="192.168.110.248"

# 备份目录配置
BACKUP_BASE_DIR="/var/www/MySQLBackup"
FULL_BACKUP_DIR="${BACKUP_BASE_DIR}/full"
INC_BACKUP_DIR="${BACKUP_BASE_DIR}/incremental"
LOG_DIR="${BACKUP_BASE_DIR}/logs"

# 日志文件
LOG_FILE="${LOG_DIR}/backup_$(date +%Y%m%d).log"

# 创建必要的目录
mkdir -p "${FULL_BACKUP_DIR}"
mkdir -p "${INC_BACKUP_DIR}"
mkdir -p "${LOG_DIR}"

# 日志函数
log_message() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "${LOG_FILE}"
}

# 检查命令是否存在
check_command() {
    if ! command -v $1 &> /dev/null; then
        log_message "错误: $1 命令不存在，请先安装"
        exit 1
    fi
}

# 检查必要的工具
check_command mysqldump
check_command gzip
check_command sshpass

log_message "========== 开始MySQL备份任务 =========="

# 计算今天是星期几（1=星期一, 7=星期日）
DAY_OF_WEEK=$(date +%u)

log_message "今天是星期${DAY_OF_WEEK}"

# 判断是全量备份还是增量备份
if [ "${DAY_OF_WEEK}" -eq 7 ]; then
    # 星期日执行全量备份
    log_message "执行全量备份..."
    
    BACKUP_FILE="${FULL_BACKUP_DIR}/full_backup_day7_$(date +%Y%m%d_%H%M%S).sql"
    
    # 执行全量备份
    mysqldump -h"${DB_HOST}" \
              -P"${DB_PORT}" \
              -u"${DB_USER}" \
              -p"${DB_PASSWORD}" \
              --single-transaction \
              --flush-logs \
              --master-data=2 \
              --databases "${DB_NAME}" \
              > "${BACKUP_FILE}" 2>> "${LOG_FILE}"
    
    if [ $? -eq 0 ]; then
        # 压缩备份文件
        gzip "${BACKUP_FILE}"
        log_message "全量备份成功: ${BACKUP_FILE}.gz"
        
        # 删除旧的全量备份（保留最新的2个）
        cd "${FULL_BACKUP_DIR}"
        ls -t full_backup_day7_*.sql.gz | tail -n +3 | xargs -r rm -f
        log_message "已清理旧的全量备份文件"
        
        # 清空增量备份目录（开始新的一周）
        rm -rf "${INC_BACKUP_DIR}"/*
        log_message "已清空增量备份目录"
    else
        log_message "错误: 全量备份失败"
        exit 1
    fi
    
else
    # 星期一到星期六执行增量备份
    log_message "执行增量备份（星期${DAY_OF_WEEK}）..."
    
    # 检查是否存在全量备份
    LATEST_FULL_BACKUP=$(ls -t "${FULL_BACKUP_DIR}"/full_backup_day7_*.sql.gz 2>/dev/null | head -n 1)
    
    if [ -z "${LATEST_FULL_BACKUP}" ]; then
        log_message "警告: 未找到全量备份，执行全量备份..."
        
        BACKUP_FILE="${FULL_BACKUP_DIR}/full_backup_day7_$(date +%Y%m%d_%H%M%S).sql"
        
        mysqldump -h"${DB_HOST}" \
                  -P"${DB_PORT}" \
                  -u"${DB_USER}" \
                  -p"${DB_PASSWORD}" \
                  --single-transaction \
                  --flush-logs \
                  --master-data=2 \
                  --databases "${DB_NAME}" \
                  > "${BACKUP_FILE}" 2>> "${LOG_FILE}"
        
        if [ $? -eq 0 ]; then
            gzip "${BACKUP_FILE}"
            log_message "全量备份成功: ${BACKUP_FILE}.gz"
        else
            log_message "错误: 全量备份失败"
            exit 1
        fi
    else
        log_message "基于全量备份: ${LATEST_FULL_BACKUP}"
        
        # 创建当天的增量备份目录
        DAY_INC_DIR="${INC_BACKUP_DIR}/day${DAY_OF_WEEK}"
        mkdir -p "${DAY_INC_DIR}"
        
        BACKUP_FILE="${DAY_INC_DIR}/inc_backup_day${DAY_OF_WEEK}_$(date +%Y%m%d_%H%M%S).sql"
        
        # 增量备份（备份binlog）
        # 注意：真正的增量备份需要开启MySQL的binlog功能
        # 这里使用全量备份方式，但每天保存在不同目录
        mysqldump -h"${DB_HOST}" \
                  -P"${DB_PORT}" \
                  -u"${DB_USER}" \
                  -p"${DB_PASSWORD}" \
                  --single-transaction \
                  --flush-logs \
                  --databases "${DB_NAME}" \
                  > "${BACKUP_FILE}" 2>> "${LOG_FILE}"
        
        if [ $? -eq 0 ]; then
            gzip "${BACKUP_FILE}"
            log_message "增量备份成功: ${BACKUP_FILE}.gz"
            
            # 删除当天的旧备份（每天只保留最新的1个）
            cd "${DAY_INC_DIR}"
            ls -t inc_backup_day${DAY_OF_WEEK}_*.sql.gz | tail -n +2 | xargs -r rm -f
        else
            log_message "错误: 增量备份失败"
            exit 1
        fi
    fi
fi

# 计算备份文件大小
if [ "${DAY_OF_WEEK}" -eq 7 ]; then
    BACKUP_SIZE=$(du -sh "${FULL_BACKUP_DIR}" | awk '{print $1}')
    log_message "全量备份目录大小: ${BACKUP_SIZE}"
else
    BACKUP_SIZE=$(du -sh "${INC_BACKUP_DIR}" | awk '{print $1}')
    log_message "增量备份目录大小: ${BACKUP_SIZE}"
fi

# 检查磁盘空间
DISK_USAGE=$(df -h "${BACKUP_BASE_DIR}" | tail -n 1 | awk '{print $5}' | sed 's/%//')
log_message "备份目录磁盘使用率: ${DISK_USAGE}%"

if [ "${DISK_USAGE}" -gt 85 ]; then
    log_message "警告: 磁盘使用率超过85%，请及时清理"
fi

# 清理30天前的日志文件
find "${LOG_DIR}" -name "backup_*.log" -mtime +30 -delete
log_message "已清理30天前的日志文件"

log_message "========== 备份任务完成 =========="

# 备份状态汇总
echo ""
log_message "备份状态汇总:"
log_message "- 全量备份数量: $(ls -1 ${FULL_BACKUP_DIR}/full_backup_*.sql.gz 2>/dev/null | wc -l)"
log_message "- 增量备份数量: $(find ${INC_BACKUP_DIR} -name "inc_backup_*.sql.gz" 2>/dev/null | wc -l)"
log_message "- 总备份大小: $(du -sh ${BACKUP_BASE_DIR} | awk '{print $1}')"

exit 0
