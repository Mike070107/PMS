-- 用户于本次会话授权纠正。只处理这一单，保留原话、类型、负责人和状态；幂等执行。
BEGIN;
DO $$
DECLARE r repair_requests%ROWTYPE; target_house integer; n integer;
BEGIN
  SELECT req.* INTO STRICT r FROM repair_requests req JOIN work_orders w ON w.request_id=req.id
    WHERE w.order_no='RX-20261022-YAXG' AND w.tenant_id=1 FOR UPDATE OF req;
  SELECT count(*),min(id) INTO n,target_house FROM houses WHERE tenant_id=1 AND building_id=120 AND room_no='1302';
  IF n<>1 OR target_house<>1510 THEN RAISE EXCEPTION '房屋匹配发生变化，停止'; END IF;
  IF r.house_id=target_house AND r.address_text='枫桦景苑二期51号1302室' THEN RETURN; END IF;
  IF r.building_id<>120 OR r.house_id IS NOT NULL OR r.address_text<>'枫桦景苑二期51号 公共区域'
    OR position('228弄51号1302' in coalesce(r.original_content,''))=0 THEN
    RAISE EXCEPTION '原工单快照发生变化，停止';
  END IF;
  UPDATE repair_requests SET house_id=target_house,address_text='枫桦景苑二期51号1302室',updated_at=now() WHERE id=r.id;
  INSERT INTO work_order_logs(tenant_id,work_order_id,from_status,to_status,action,note)
    SELECT w.tenant_id,w.id,w.status,w.status,'progress',
      '按用户确认及原始报修内容纠正地址：枫桦景苑二期51号 公共区域 → 枫桦景苑二期51号1302室（house_id：空 → 1510）；保留原话、类型及接单状态。通知核验：建单候选叶双、孔赟；孔赟微信订阅额度为0，仅站内通知。未补发旧消息。'
    FROM work_orders w WHERE w.request_id=r.id AND w.tenant_id=1;
END $$;
COMMIT;
SELECT w.order_no,w.status,w.assignee_id,r.address_text,r.house_id,r.original_content FROM work_orders w JOIN repair_requests r ON r.id=w.request_id WHERE w.order_no='RX-20261022-YAXG';
