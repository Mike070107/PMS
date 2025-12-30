-- =====================================================
-- 性能优化：为addresses表创建索引
-- 执行方法：在MySQL客户端中执行此脚本
-- =====================================================

-- 1. 为小区编号字段创建索引（加速按小区筛选）
CREATE INDEX IF NOT EXISTS idx_addresses_community ON addresses(小区编号);

-- 2. 为楼栋号字段创建索引（加速DISTINCT查询和筛选）
CREATE INDEX IF NOT EXISTS idx_addresses_building ON addresses(楼栋号);

-- 3. 创建复合索引（加速同时按小区和楼栋筛选的查询）
CREATE INDEX IF NOT EXISTS idx_addresses_community_building ON addresses(小区编号, 楼栋号);

-- 4. 为房间号字段创建索引（可选，加速房间查询）
CREATE INDEX IF NOT EXISTS idx_addresses_room ON addresses(房间号);

-- =====================================================
-- 验证索引是否创建成功
-- =====================================================
SHOW INDEX FROM addresses;

-- =====================================================
-- 如果上面的IF NOT EXISTS语法不支持，使用以下替代方案：
-- =====================================================
-- 先检查索引是否存在，再创建
-- ALTER TABLE addresses ADD INDEX idx_addresses_community (小区编号);
-- ALTER TABLE addresses ADD INDEX idx_addresses_building (楼栋号);
-- ALTER TABLE addresses ADD INDEX idx_addresses_community_building (小区编号, 楼栋号);
