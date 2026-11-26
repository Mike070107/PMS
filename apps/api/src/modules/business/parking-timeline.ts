import type { BusinessLedgerQuery } from './business-ledger.service';

type Query = (sql: string, params: any[]) => Promise<any[]>;

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
    conditions.push(`(e.plate ILIKE ${term} OR e.new_plate ILIKE ${term} OR u.name ILIKE ${term} OR '#'||e.source_number::text ILIKE ${term})`);
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
      AND NULLIF(o.payload->>'businessTxnNo','') IS NULL AND o.idempotency_key NOT LIKE 'biz:%'
    UNION ALL
    SELECT -2::bigint*h.id-1,h.id,h.tenant_id,h.database,h.source_record_id,h.operator_user_id,h.occurred_at,
      (h.occurred_at AT TIME ZONE 'Asia/Shanghai')::date,h.plate_before,h.plate_after,
      jsonb_build_object('historyId',h.id,'kind',h.event_type,'database',h.database,'status','completed')
    FROM parking_history h WHERE h.tenant_id=${company} AND h.source='pms' AND h.event_type='owner_info_update'
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
