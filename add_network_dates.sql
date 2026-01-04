-- 为orders表添加网费开始日期和结束日期字段
-- 执行时间: 2026-01-04

USE wjwy;

-- 添加网费开始日期字段
ALTER TABLE orders 
ADD COLUMN 网费开始日期 DATE NULL COMMENT '网费开始日期' AFTER 网费金额;

-- 添加网费结束日期字段
ALTER TABLE orders 
ADD COLUMN 网费结束日期 DATE NULL COMMENT '网费结束日期' AFTER 网费开始日期;

-- 查看表结构确认
DESCRIBE orders;
