import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DataSource } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import { ResolvedAccess } from '../access/access.service';
import { SaveScreenSettingsDto } from './screen-settings.dto';
import { loadCollectionTargets } from './collection-targets.util';
@Injectable()
export class ScreenSettingsService {
  constructor(private readonly db: DataSource) {}
  async scope(user: AuthUser, access: ResolvedAccess, requested?: string) {
    if (!user.tenantId) throw new ForbiddenException('请先选择公司');
    const rows: { id: number; name: string }[] = await this.db.query('SELECT id,name FROM communities WHERE tenant_id=$1 AND enabled=true ORDER BY id', [user.tenantId]);
    const allowed = rows.filter(row => access.scopeAll || access.communityIds?.includes(Number(row.id)));
    if (!requested) return allowed;
    const ids = requested.split(',').map(Number);
    if (!ids.length || ids.some(id => !Number.isInteger(id) || !allowed.some(row => Number(row.id) === id))) throw new ForbiddenException('选择的小区不在当前授权范围');
    return allowed.filter(row => ids.includes(Number(row.id)));
  }
  private key(year: number, ids: number[]) {
    return `screen_decision_${year}_${createHash('sha256').update([...ids].sort((a,b) => a-b).join(',')).digest('hex').slice(0, 20)}`;
  }
  async read(user: AuthUser, access: ResolvedAccess, year: number, requested?: string) {
    const communities = await this.scope(user, access, requested);
    const ids = communities.map(row => Number(row.id));
    const rows = await this.db.query('SELECT value,updated_at AS "updatedAt" FROM tenant_configs WHERE tenant_id=$1 AND key=$2', [user.tenantId, this.key(year, ids)]);
    const stored = rows[0]?.value;
    const targets = (await loadCollectionTargets(this.db, Number(user.tenantId), ids, year)).filter(row => row.communityIds.every(id => ids.includes(id)));
    return { year, communities, targets, revision: stored?.revision || 0, manual: stored?.manual || null, owners: stored?.owners || [], updatedAt: rows[0]?.updatedAt || null };
  }
  async save(user: AuthUser, access: ResolvedAccess, dto: SaveScreenSettingsDto) {
    const year = dto.year || Number(new Intl.DateTimeFormat('en', { year: 'numeric', timeZone: 'Asia/Shanghai' }).format(new Date()));
    const communities = await this.scope(user, access, dto.communityIds);
    if (!communities.length) throw new BadRequestException('当前范围没有可设置的小区');
    if (dto.owners.some(owner => !communities.some(row => Number(row.id) === owner.communityId))) throw new ForbiddenException('负责人包含范围外小区');
    if (new Set(dto.owners.map(o => o.communityId)).size !== dto.owners.length) throw new BadRequestException('小区负责人不能重复');
    if (dto.manual && dto.manual.keptPromises > dto.manual.duePromises) throw new BadRequestException('兑现承诺数不能超过到期承诺数');
    if (dto.manual && Number(dto.manual.asOf.slice(0,4)) !== year) throw new BadRequestException('人工数据日期必须在所选年度内');
    if (dto.manual && !dto.manual.sample && dto.manual.asOf.slice(0,10) > new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date())) throw new BadRequestException('正式人工数据日期不能晚于今天');
    const value = { revision: dto.revision + 1, manual: dto.manual || null, owners: dto.owners };
    const key = this.key(year, communities.map(row => Number(row.id)));
    const saved = await this.db.query(`INSERT INTO tenant_configs(tenant_id,key,value,created_by,updated_by)
      SELECT $1,$2,$3::jsonb,$4,$4 WHERE $5=0
      ON CONFLICT(tenant_id,key) DO NOTHING RETURNING id`, [user.tenantId, key, JSON.stringify(value), user.id, dto.revision]);
    if (!saved.length) {
      const updated = await this.db.query(`UPDATE tenant_configs SET value=$1::jsonb,updated_by=$2,updated_at=now()
        WHERE tenant_id=$3 AND key=$4 AND (value->>'revision')::int=$5 RETURNING id`,
        [JSON.stringify(value), user.id, user.tenantId, key, dto.revision]);
      if (!updated.length) throw new ConflictException('设置已被其他人修改，请重新载入后再保存');
    }
    return this.read(user, access, year, dto.communityIds);
  }
}
