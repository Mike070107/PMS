/** Persist actual business usage separately from confirmed successful contact. */
export async function recordOwnerPhoneUsage(db: { query: Function }, tenantId: number, phone?: string | null) {
  if (!phone?.trim()) return;
  await db.query(`INSERT INTO owner_phone_activity(tenant_id,owner_id,phone,last_used_at)
    SELECT tenant_id,id,$2::varchar,now() FROM users
    WHERE tenant_id=$1 AND role='owner' AND (phone=$2::varchar OR contact_phones ? $2::text)
    ON CONFLICT(tenant_id,owner_id,phone) DO UPDATE SET last_used_at=EXCLUDED.last_used_at`, [tenantId, phone.trim()]);
}
