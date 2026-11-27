import { EntityManager, In } from 'typeorm';
import { ParkingQuery, ParkingRecordSnapshot, ParkingHistory, User } from '../../entities';
import { diffParkingSnapshot, normalizeParkingSourceRecordId, type ParkingSnapshotValues } from './parking-history.util';
import { parkingLegacyRoomFromName } from './parking-query.util';
import { parkingLegacyOwnerValuesFromFields } from './parking-owner-update.util';

export async function captureParkingQueryHistory(manager: EntityManager, query: ParkingQuery, observedAt: Date,
  snapshotValues: (fields: ParkingQuery['rows'][number]['fields'], database: string) => ParkingSnapshotValues = parkingSnapshotValues) {
  const factsByKey = new Map<string, {
    database: string;
    sourceRecordId: string;
    values: ParkingSnapshotValues;
  }>();
  for (const row of query.rows) {
    const sourceRecordId = parkingSourceRecordId(row.fields);
    if (sourceRecordId) {
      const fact = {
      database: row.database,
      sourceRecordId,
      values: snapshotValues(row.fields, row.database),
      };
      // 同一批结果若重复返回同一主键，只保留最后一份快照，避免一次查询生成多条伪变更。
      factsByKey.set(`${fact.database}\u0000${fact.sourceRecordId}`, fact);
    }
  }
  const facts = Array.from(factsByKey.values());
  if (!facts.length) return;
  const snapshotRepo = manager.getRepository(ParkingRecordSnapshot);
  const historyRepo = manager.getRepository(ParkingHistory);
  const ids = Array.from(new Set(facts.map((item) => item.sourceRecordId)));
  const existing = await snapshotRepo.find({ where: { tenantId: query.tenantId, sourceRecordId: In(ids) } });
  const byKey = new Map(existing.map((item) => [`${item.database}\u0000${item.sourceRecordId}`, item]));
  const phones = Array.from(new Set(facts.map((item) => normalizeParkingPhone(item.values.phone)).filter((item): item is string => Boolean(item))));
  const pmsUsers = phones.length ? await manager.find(User, { where: { tenantId: query.tenantId, phone: In(phones) } }) : [];
  const userByPhone = new Map(pmsUsers.filter((item) => item.phone).map((item) => [normalizeParkingPhone(item.phone), item] as const));
  const histories: ParkingHistory[] = [];
  const snapshots: ParkingRecordSnapshot[] = [];
  const ownerInfoKeys = new Set<string>();

  for (const fact of facts) {
    const key = `${fact.database}\u0000${fact.sourceRecordId}`;
    const prior = byKey.get(key);
    const pmsUser = fact.values.phone ? userByPhone.get(normalizeParkingPhone(fact.values.phone) ?? '') : undefined;
    for (const event of diffParkingSnapshot(prior?.values ?? null, fact.values)) {
      const operationTime = event.eventType === 'plate_change' ? parkingOperationTime(event.occurredAt) : null;
      const dedupeKey = event.eventType === 'owner_info_update'
        ? `${fact.database}\u0000${fact.values.ownerId ?? ''}\u0000${JSON.stringify(event.changes)}`
        : null;
      if (dedupeKey && ownerInfoKeys.has(dedupeKey)) continue;
      if (dedupeKey) ownerInfoKeys.add(dedupeKey);
      histories.push(historyRepo.create({
        tenantId: query.tenantId,
        eventType: event.eventType,
        source: 'parking_gateway',
        database: fact.database,
        sourceRecordId: fact.sourceRecordId,
        pmsUserId: pmsUser?.id ?? null,
        externalOwnerId: fact.values.ownerId ?? prior?.values.ownerId ?? null,
        plateBefore: prior?.values.plate ?? null,
        plateAfter: fact.values.plate,
        summary: event.summary,
        changes: event.changes,
        operatorUserId: null,
        detectedByQueryId: query.id,
        occurredAt: operationTime ?? observedAt,
        timeBasis: operationTime ? 'operation' : 'detected',
        createdBy: null,
        updatedBy: null,
      }));
    }
    const snapshot = prior ?? snapshotRepo.create({
      tenantId: query.tenantId,
      database: fact.database,
      sourceRecordId: fact.sourceRecordId,
      createdBy: null,
    });
    snapshot.values = fact.values;
    snapshot.observedAt = observedAt;
    snapshot.updatedBy = null;
    snapshots.push(snapshot);
    byKey.set(key, snapshot);

    const knownPlateChangeAt = parkingOperationTime(fact.values.plateChangedAt);
    if (knownPlateChangeAt && fact.values.plate) {
      // 旧版曾把“查询发现变化”的时刻记成换牌时间；新助手读到 Up_Issue 后就地校正。
      await historyRepo.createQueryBuilder()
        .update(ParkingHistory)
        .set({ occurredAt: knownPlateChangeAt, timeBasis: 'operation' })
        .where('tenant_id = :tenantId', { tenantId: query.tenantId })
        .andWhere('database = :database', { database: fact.database })
        .andWhere('source_record_id = :sourceRecordId', { sourceRecordId: fact.sourceRecordId })
        .andWhere('plate_after = :plate', { plate: fact.values.plate })
        .andWhere("event_type = 'plate_change'")
        .andWhere("time_basis = 'detected'")
        .execute();
    }
  }
  if (histories.length) await historyRepo.save(histories);
  await snapshotRepo.save(snapshots);
}

export function normalizeParkingFieldName(value: string): string {
  return value.toLowerCase().replace(/[\s_\-./]/g, '');
}

export function parkingFieldValue(
  fields: Record<string, string | number | boolean | null>,
  aliases: readonly string[],
): string | null {
  const entries = Object.entries(fields).filter(([, value]) => value !== null && String(value).trim() !== '');
  for (const alias of aliases) {
    const normalizedAlias = normalizeParkingFieldName(alias);
    const match = entries.find(([key]) => normalizeParkingFieldName(key).includes(normalizedAlias));
    if (match) return String(match[1]).trim();
  }
  return null;
}

export function normalizeParkingPhone(value: string | null): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  return /^1\d{10}$/.test(digits) ? digits : null;
}

export function normalizeParkingText(value: string | null | undefined): string | null {
  const result = value?.trim();
  return result || null;
}

export function parkingExactFieldValue(
  fields: Record<string, string | number | boolean | null>,
  aliases: readonly string[],
): string | null {
  for (const alias of aliases) {
    const normalizedAlias = normalizeParkingFieldName(alias);
    const match = Object.entries(fields).find(([key, value]) =>
      value !== null && String(value).trim() !== '' && normalizeParkingFieldName(key) === normalizedAlias);
    if (match) return String(match[1]).trim();
  }
  return null;
}

export function parkingSourceRecordId(fields: Record<string, string | number | boolean | null>): string | null {
  for (const alias of ['p_id', 'pid', 'issue_id', 'issueid', 'car_id', 'carid']) {
    const value = normalizeParkingSourceRecordId(parkingExactFieldValue(fields, [alias]));
    if (value) return value;
  }
  return null;
}

export function parkingExternalOwnerId(fields: Record<string, string | number | boolean | null>): string | null {
  return parkingExactFieldValue(fields, ['owner_id', 'ownerid', '住户编号', '业主编号']);
}

export function parkingSnapshotValues(fields: Record<string, string | number | boolean | null>, database?: string): ParkingSnapshotValues {
  const owner = parkingLegacyOwnerValuesFromFields(fields, database);
  const room = parkingLegacyRoomFromName(owner.room, database) ?? owner.room;
  return {
    plate: normalizeParkingText(parkingFieldValue(fields, ['p_plate', 'carno', 'carcode', 'carnumber', 'plateno', 'plate', 'license', '车牌'])),
    ownerId: parkingExternalOwnerId(fields),
    ownerName: owner.name,
    phone: owner.phone,
    room,
    // P_note 属于 Car_Issue 车辆记录，不应因存在 Owner__ 字段而被住户表联查逻辑遮掉。
    note: normalizeParkingText(parkingFieldValue(fields, ['remark', 'remarks', 'note', 'pnote', '备注'])),
    plateChangedAt: normalizeParkingText(parkingExactFieldValue(fields, ['pmsmeta__platechangedat'])),
  };
}

export function parkingOperationTime(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return null;
  // 防止异常旧库值把历史排序推到不可信的年代。
  const earliest = new Date('2000-01-01T00:00:00+08:00').getTime();
  const latest = Date.now() + 24 * 60 * 60 * 1000;
  return parsed.getTime() >= earliest && parsed.getTime() <= latest ? parsed : null;
}
