-- One-off plan: tenant 1, keep warehouse 2. Default is READ ONLY.
-- Apply only after the user confirms historical deletion and backup is verified.
-- psql -v ON_ERROR_STOP=1 -v apply=false -f inventory-cleanup-20261111.sql
\if :{?apply}
\else
  \set apply false
\endif
SELECT w.id,w.name,count(s.id) AS stock_rows,coalesce(sum(s.qty),0) AS qty
FROM warehouses w LEFT JOIN stocks s ON s.tenant_id=w.tenant_id AND s.warehouse_id=w.id
WHERE w.tenant_id=1 GROUP BY w.id ORDER BY w.id;
\if :apply
BEGIN ISOLATION LEVEL SERIALIZABLE;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
LOCK TABLE stocks,stock_lots,stock_movements,materials,goods_receipts,stocktake_tasks,
 stocktake_items,work_order_materials,work_order_material_allocations,work_orders,
 purchase_requests,purchase_orders,transfer_orders,supplier_materials IN SHARE ROW EXCLUSIVE MODE;
CREATE TEMP TABLE cleanup_materials ON COMMIT DROP AS
 SELECT m.id FROM materials m WHERE m.tenant_id=1 AND m.id<>37
 AND NOT EXISTS(SELECT 1 FROM stocks s WHERE s.tenant_id=1 AND s.warehouse_id=2 AND s.material_id=m.id)
 AND EXISTS(SELECT 1 FROM stocks s WHERE s.tenant_id=1 AND s.warehouse_id<>2 AND s.material_id=m.id);
CREATE TEMP TABLE cleanup_protected ON COMMIT DROP AS
 SELECT 'stocks' AS name,jsonb_agg(to_jsonb(s) ORDER BY id) AS body FROM stocks s WHERE tenant_id=1 AND warehouse_id=2 AND id<>79
 UNION ALL SELECT 'lots',jsonb_agg(to_jsonb(l) ORDER BY id) FROM stock_lots l WHERE tenant_id=1 AND warehouse_id=2
 UNION ALL SELECT 'movements',jsonb_agg(to_jsonb(m) ORDER BY id) FROM stock_movements m WHERE tenant_id=1 AND warehouse_id=2
 UNION ALL SELECT 'receipts',jsonb_agg(to_jsonb(g) ORDER BY id) FROM goods_receipts g WHERE tenant_id=1 AND warehouse_id=2
 UNION ALL SELECT 'work_materials',jsonb_agg(to_jsonb(w) ORDER BY id) FROM work_order_materials w WHERE tenant_id=1 AND warehouse_id=2;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM warehouses WHERE tenant_id=1 AND id=2 AND name='智能化维修工仓库') THEN RAISE EXCEPTION 'warehouse identity drift'; END IF;
 IF (SELECT count(*) FROM stocks WHERE tenant_id=1 AND warehouse_id<>2)<>61
 OR (SELECT count(*) FROM stock_lots WHERE tenant_id=1 AND warehouse_id<>2)<>68
 OR (SELECT count(*) FROM stock_movements WHERE tenant_id=1 AND warehouse_id<>2)<>82
 OR (SELECT count(*) FROM goods_receipts WHERE tenant_id=1 AND warehouse_id<>2)<>9
 OR (SELECT count(*) FROM stocktake_tasks WHERE tenant_id=1 AND warehouse_id<>2)<>1
 OR (SELECT count(*) FROM cleanup_materials)<>55
 OR (SELECT count(*) FROM work_order_materials WHERE tenant_id=1 AND warehouse_id<>2)<>1
 THEN RAISE EXCEPTION 'baseline drift: audit again'; END IF;
 IF (SELECT array_agg(id ORDER BY id) FROM cleanup_materials) IS DISTINCT FROM
 ARRAY(SELECT n FROM generate_series(1,55) n WHERE n<>37 UNION SELECT 71 ORDER BY 1)
 THEN RAISE EXCEPTION 'material identity drift'; END IF;
 IF EXISTS(SELECT 1 FROM stocks WHERE tenant_id=1 AND warehouse_id=2 AND material_id=37) THEN RAISE EXCEPTION 'float valve row reappeared: audit again'; END IF;
 IF NOT EXISTS(SELECT 1 FROM work_order_materials WHERE tenant_id=1 AND id=14 AND warehouse_id=1 AND work_order_id=49 AND material_id=24 AND total_cost_cents=600) THEN RAISE EXCEPTION 'work material identity drift'; END IF;
 IF to_regclass('public.stock_reservations') IS NOT NULL OR to_regclass('public.work_order_material_drafts') IS NOT NULL THEN RAISE EXCEPTION 'new reservation schema: audit before cleanup'; END IF;
END $$;
DELETE FROM work_order_material_allocations WHERE tenant_id=1 AND work_order_material_id=14;
DELETE FROM work_order_materials WHERE tenant_id=1 AND id=14 AND warehouse_id=1;
UPDATE work_orders w SET used_materials=(SELECT coalesce(jsonb_agg(e.value ORDER BY e.ordinality),'[]'::jsonb)
 FROM jsonb_array_elements(w.used_materials) WITH ORDINALITY e WHERE e.value->>'materialId' IS DISTINCT FROM '24'),updated_at=now()
 WHERE tenant_id=1 AND id=49;
DELETE FROM stocktake_items WHERE tenant_id=1 AND task_id IN (SELECT id FROM stocktake_tasks WHERE tenant_id=1 AND warehouse_id<>2);
DELETE FROM stocktake_tasks WHERE tenant_id=1 AND warehouse_id<>2;
-- Keep cross-warehouse transfer history and its referenced source lot (id 37).
-- That lot's remaining quantity must still become zero to clear other stock.
UPDATE stock_lots SET remaining_qty=0,updated_at=now() WHERE tenant_id=1 AND id=37 AND warehouse_id=1;
DELETE FROM stock_lots WHERE tenant_id=1 AND warehouse_id<>2 AND id<>37;
DELETE FROM stock_movements WHERE tenant_id=1 AND warehouse_id<>2 AND NOT coalesce(ref_type='transfer_order' AND ref_id IN (1,2),false);
DELETE FROM goods_receipts WHERE tenant_id=1 AND warehouse_id<>2;
DELETE FROM stocks WHERE tenant_id=1 AND warehouse_id<>2;
DELETE FROM stocks WHERE tenant_id=1 AND id=79 AND warehouse_id=2 AND material_id=37 AND qty=0;
-- No SKU is removed until every structured and JSON business reference is checked.
DO $$ DECLARE r record; n bigint; BEGIN
 FOR r IN SELECT * FROM (VALUES
 ('stocks','material_id'),('stock_lots','material_id'),('stock_movements','material_id'),
 ('stocktake_items','material_id'),('work_order_materials','material_id'),('supplier_materials','material_id')) v(t,c)
 LOOP
  EXECUTE format('SELECT count(*) FROM %I x JOIN cleanup_materials c ON x.%I=c.id WHERE x.tenant_id=1',r.t,r.c) INTO n;
  IF n>0 THEN RAISE EXCEPTION 'remaining material references: %',r.t; END IF;
 END LOOP;
 FOR r IN SELECT * FROM (VALUES ('purchase_requests','items'),('purchase_orders','items'),('goods_receipts','items'),
 ('transfer_orders','items'),('work_orders','used_materials'),('work_orders','missing_materials')) v(t,c)
 LOOP
  EXECUTE format('SELECT count(*) FROM %I x CROSS JOIN LATERAL jsonb_array_elements(coalesce(x.%I,''[]''::jsonb)) e JOIN cleanup_materials c ON e->>''materialId''=c.id::text WHERE x.tenant_id=1',r.t,r.c) INTO n;
  IF n>0 THEN RAISE EXCEPTION 'remaining material JSON references: %.%',r.t,r.c; END IF;
 END LOOP;
END $$;
DELETE FROM materials WHERE tenant_id=1 AND id IN (SELECT id FROM cleanup_materials);
-- Same rule as refreshMaterialReferenceCost: no remaining lots -> keep old reference.
UPDATE materials m SET default_cost_cents=l.cost,updated_at=now()
 FROM (SELECT material_id,round(sum(remaining_qty*unit_cost_cents)/sum(remaining_qty))::int AS cost
 FROM stock_lots WHERE tenant_id=1 AND remaining_qty>0 GROUP BY material_id) l
 WHERE m.tenant_id=1 AND m.id=l.material_id AND m.default_cost_cents IS DISTINCT FROM l.cost;
DO $$ DECLARE actual jsonb; p record; BEGIN
 FOR p IN SELECT * FROM cleanup_protected LOOP
  IF p.name='stocks' THEN SELECT jsonb_agg(to_jsonb(s) ORDER BY id) INTO actual FROM stocks s WHERE tenant_id=1 AND warehouse_id=2 AND id<>79;
  ELSIF p.name='lots' THEN SELECT jsonb_agg(to_jsonb(l) ORDER BY id) INTO actual FROM stock_lots l WHERE tenant_id=1 AND warehouse_id=2;
  ELSIF p.name='movements' THEN SELECT jsonb_agg(to_jsonb(m) ORDER BY id) INTO actual FROM stock_movements m WHERE tenant_id=1 AND warehouse_id=2;
  ELSIF p.name='receipts' THEN SELECT jsonb_agg(to_jsonb(g) ORDER BY id) INTO actual FROM goods_receipts g WHERE tenant_id=1 AND warehouse_id=2;
  ELSIF p.name='work_materials' THEN SELECT jsonb_agg(to_jsonb(w) ORDER BY id) INTO actual FROM work_order_materials w WHERE tenant_id=1 AND warehouse_id=2;
  END IF;
  IF actual IS DISTINCT FROM p.body THEN RAISE EXCEPTION 'protected warehouse changed: %',p.name; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM stocks WHERE tenant_id=1 AND warehouse_id<>2)
 OR EXISTS(SELECT 1 FROM stock_lots WHERE tenant_id=1 AND warehouse_id<>2 AND remaining_qty<>0)
 THEN RAISE EXCEPTION 'other stock not empty'; END IF;
 IF EXISTS(SELECT 1 FROM work_order_material_allocations a LEFT JOIN stock_lots l ON l.id=a.stock_lot_id AND l.tenant_id=a.tenant_id WHERE a.tenant_id=1 AND l.id IS NULL)
 THEN RAISE EXCEPTION 'orphan work material allocation'; END IF;
 IF EXISTS(SELECT 1 FROM transfer_orders t CROSS JOIN LATERAL jsonb_array_elements(t.items) i
 CROSS JOIN LATERAL jsonb_array_elements(coalesce(i->'allocations','[]'::jsonb)) a
 LEFT JOIN stock_lots l ON l.id=(a->>'stockLotId')::int AND l.tenant_id=t.tenant_id
 WHERE t.tenant_id=1 AND t.id IN (1,2) AND l.id IS NULL)
 THEN RAISE EXCEPTION 'orphan transfer allocation'; END IF;
END $$;
SELECT 'after',warehouse_id,count(*),sum(qty) FROM stocks WHERE tenant_id=1 GROUP BY warehouse_id;
COMMIT;
\else
\echo 'READ ONLY: no data changed. Historical deletion still requires the confirmed scope.'
\endif
