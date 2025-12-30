-- 操作日志表
-- 执行前请先备份数据库
-- 如果表已存在，请先检查现有数据

CREATE TABLE IF NOT EXISTS operation_logs (
    ID BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '日志唯一标识',
    
    -- 时间信息
    操作时间 DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '操作时间',
    
    -- 用户信息
    用户ID INT NOT NULL COMMENT '操作用户ID',
    用户账号 VARCHAR(50) NOT NULL COMMENT '用户名',
    用户姓名 VARCHAR(50) COMMENT '真实姓名',
    用户角色 VARCHAR(20) NOT NULL COMMENT '用户角色（系统管理员/小区操作员）',
    所属小区 VARCHAR(100) COMMENT '所属小区',
    小区编号 INT COMMENT '小区编号',
    
    -- 网络信息
    电脑IP VARCHAR(50) COMMENT 'IP地址',
    MAC地址 VARCHAR(50) COMMENT 'MAC地址（需前端上报）',
    用户代理 TEXT COMMENT '浏览器UserAgent',
    
    -- 操作信息
    操作类型 VARCHAR(50) NOT NULL COMMENT '操作类型（登录/登出/新增/修改/删除/查询/导出/打印等）',
    操作模块 VARCHAR(50) NOT NULL COMMENT '操作模块（用户管理/订单管理/收费标准管理/数据报表等）',
    操作详情 TEXT COMMENT '操作详情（JSON格式存储详细信息）',
    
    -- 业务相关
    目标ID VARCHAR(100) COMMENT '操作对象的ID（如订单ID、用户ID等）',
    目标类型 VARCHAR(50) COMMENT '操作对象类型（订单/用户/收费标准等）',
    
    -- 结果信息
    操作结果 VARCHAR(20) NOT NULL DEFAULT 'success' COMMENT '操作结果（success/fail/error）',
    错误信息 TEXT COMMENT '错误信息（失败时记录）',
    
    -- 请求信息
    请求方法 VARCHAR(10) COMMENT 'HTTP请求方法（GET/POST/PUT/DELETE）',
    请求URL TEXT COMMENT '请求的完整URL',
    请求参数 TEXT COMMENT '请求参数（JSON格式）',
    
    -- 响应信息
    响应时间 INT COMMENT '响应时间（毫秒）',
    
    -- 索引优化
    INDEX idx_operation_time (操作时间),
    INDEX idx_user_id (用户ID),
    INDEX idx_username (用户账号),
    INDEX idx_community (所属小区),
    INDEX idx_community_id (小区编号),
    INDEX idx_operation_type (操作类型),
    INDEX idx_operation_module (操作模块),
    INDEX idx_target_id (目标ID),
    INDEX idx_composite (操作时间, 用户ID, 操作类型)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='操作日志表';

-- 创建表后，可以查看表结构
-- DESCRIBE operation_logs;

-- 示例：查询最近的100条日志
-- SELECT * FROM operation_logs ORDER BY 操作时间 DESC LIMIT 100;
