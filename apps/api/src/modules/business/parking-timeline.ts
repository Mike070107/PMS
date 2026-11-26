import type { BusinessLedgerQuery } from './business-ledger.service';

type Query = (sql: string, params: any[]) => Promise<any[]>;

const historyKinds:Record<string,string>={
  vehicle_added:'add_vehicle',vehicle_renewed:'renew_vehicle',plate_change:'change_plate',vehicle_deleted:'delete_vehicle',
  owner_rebind:'rebind_owner',owner_info_update:'owner_info_update',garage_authorization:'update_garages',
  vehicle_type_update:'update_vehicle_type',vehicle_download:'download_vehicle',vehicle_sync:'sync_vehicle_info',
};
const operationKind="CASE h.event_type "+Object.entries(historyKinds).map(([event,kind])=>`WHEN '${event}' THEN '${kind}'`).join(' ')+" END";

export function plateSearchKey(term?:string) {
  const key=term?.replace(/[\s·.．・]/g,'').toUpperCase();
  return key && /^[\u4e00-\u9fff][A-Z][A-Z0-9]{5,6}$/.test(key)?key:null;
}

// Follow a confirmed rename only through its stable record number within the same tenant/database.
export function changedVehicleSources(tenant:string,plate:string) {
  return `SELECT DISTINCT h.database,h.source_record_id FROM parking_history h
    WHERE h.tenant_id=${tenant} AND h.event_type='plate_change' AND NULLIF(h.source_record_id,'') IS NOT NULL
      AND (${plate}=regexp_replace(upper(h.plate_before),'[[:space:]·.．・]','','g')
        OR ${plate}=regexp_replace(upper(h.plate_after),'[[:space:]·.．・]','','g'))`;
}

// Both the timeline and payment details must use the same explicit linkage.
export const linkedParkingTaskSql = `t.service_type='parking_monthly' AND (
  t.txn_no=o.payload->>'businessTxnNo' OR (o.idempotency_key LIKE 'biz:%' AND t.txn_no=split_part(o.idempotency_key,':',2))
  OR t.snapshot->'execution'->'steps' @> jsonb_build_array(jsonb_build_object('operationId',o.id))
  OR t.snapshot#>>'{execution,operationId}'=o.id::text)`;

/** Page both sources before loading details. Collection totals stay on the payment query. */
export async function parkingTimelinePage(query: Query, payments: [string, any[]], tenant: number,
  communities: number[] | null, filter: BusinessLedgerQuery, requested: number, size: number) {
  const [paymentsSql, values] = payments;
  const params = [...values];
  const bind = (value: unknown) => { params.push(value); return '$' + params.length; };
  const company = bind(tenant);
  const conditions: string[] = [];
  // A database serves multiple communities. Scope only from a proven original registration,
  // rejecting ambiguous matches. The present-day owner of the same plate is insufficient.
  if (communities) {
    const scope = bind(communities);
    conditions.push(`(SELECT bool_and(t.community_id IS NOT NULL AND t.community_id=ANY(${scope}::int[]))
      FROM parking_operations a JOIN business_transactions t ON t.tenant_id=a.tenant_id
      AND a.idempotency_key='biz:'||t.txn_no||':register:'||a.database
      WHERE a.tenant_id=e.tenant AND a.database=e.db AND a.kind='add_vehicle' AND a.status='completed'
      AND a.result->>'issueId'=e.source_id AND a.completed_at<=e.at) IS TRUE`);
  }
  if (filter.from) conditions.push(`e.day>=${bind(filter.from)}::date`);
  if (filter.to) conditions.push(`e.day<=${bind(filter.to)}::date`);
  if (filter.q?.trim()) {
    const term = bind('%'+filter.q.trim().replace(/[\\%_]/g,c=>'\\'+c)+'%');
    const plate=plateSearchKey(filter.q);
    const related=plate?` OR (e.db,e.source_id) IN (${changedVehicleSources(company,bind(plate))})`:'';
    conditions.push(`(e.plate ILIKE ${term} OR e.new_plate ILIKE ${term} OR u.name ILIKE ${term} OR '#'||e.source_number::text ILIKE ${term}${related})`);
  }
  const [result] = await query(`WITH events AS (
    SELECT -2::bigint*o.id id,o.id source_number,o.tenant_id tenant,o.database db,o.source_record_id source_id,
      o.created_by actor,o.requested_at at,(o.requested_at AT TIME ZONE 'Asia/Shanghai')::date AS day,
      o.payload->>'plate' plate,o.payload->>'newPlate' new_plate,
      jsonb_build_object('taskId',o.id,'kind',o.kind,'database',o.database,'status',o.status,'completedAt',o.completed_at,
        'refund',o.payload->>'refund','depositRefund',o.payload->>'depositRefund','before',o.result->'beforeDeletion',
        'verified',o.result->'verified','remaining',o.result->'remaining','deviceVerification',o.result->>'deviceVerification',
        'retryChannels',o.result->'retryChannels','garages',o.payload->'garages','garageNumbers',o.payload->'garageNumbers') op
    FROM parking_operations o WHERE o.tenant_id=${company}
      AND NOT EXISTS (SELECT 1 FROM business_transactions t WHERE t.tenant_id=o.tenant_id
        AND ${linkedParkingTaskSql})
    UNION ALL
    SELECT -2::bigint*h.id-1,h.id,h.tenant_id,h.database,h.source_record_id,h.operator_user_id,h.occurred_at,
      (h.occurred_at AT TIME ZONE 'Asia/Shanghai')::date,h.plate_before,h.plate_after,
      jsonb_build_object('historyId',h.id,'timeBasis',to_jsonb(h)->>'time_basis','kind',${operationKind},'database',h.database,'status',CASE WHEN h.source='pms' THEN 'completed' ELSE 'observed' END)
    FROM parking_history h WHERE h.tenant_id=${company} AND ${operationKind} IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM parking_operations o WHERE o.tenant_id=h.tenant_id AND o.kind=${operationKind} AND o.status='completed'
       AND o.database=h.database AND o.source_record_id IS NOT DISTINCT FROM h.source_record_id
       AND o.completed_at=h.occurred_at AND o.payload->>'plate'=h.plate_before
       AND coalesce(o.payload->>'newPlate',o.payload->>'plate')=h.plate_after)
  ), combined AS (
    SELECT p.id,p.day::date AS day,p.at,NULL::jsonb event FROM (${paymentsSql}) p
    UNION ALL SELECT e.id,e.day,e.at,e.op||jsonb_build_object('plate',e.plate,'newPlate',e.new_plate,'operator',u.name)
    FROM events e LEFT JOIN users u ON u.id=e.actor AND u.tenant_id=e.tenant
    ${conditions.length?'WHERE '+conditions.join(' AND '):''}
  ), counts AS (SELECT count(*)::int total FROM combined)
  SELECT total,COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY day DESC,at DESC,id DESC) FROM
    (SELECT * FROM combined ORDER BY day DESC,at DESC,id DESC LIMIT ${bind(size)}
     OFFSET (LEAST(${bind(requested)}::int,GREATEST(1,ceil(counts.total::numeric/${size})::int))-1)*${size}) r),'[]'::jsonb) entries
  FROM counts`,params);
  return result as {total:number;entries:Array<{id:number;at:string;event:Record<string,any>|null}>};
}
