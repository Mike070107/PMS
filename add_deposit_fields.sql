-- 为 fee_prices 表添加押金单价字段
ALTER TABLE fee_prices ADD COLUMN deposit_fee DECIMAL(10,2) DEFAULT 30.00 COMMENT '押金单价（元/次）';

-- 为 orders 表添加押金相关字段
ALTER TABLE orders ADD COLUMN 押金次数 INT DEFAULT 0 COMMENT '押金次数';
ALTER TABLE orders ADD COLUMN 押金金额 DECIMAL(10,2) DEFAULT 0.00 COMMENT '押金金额';
