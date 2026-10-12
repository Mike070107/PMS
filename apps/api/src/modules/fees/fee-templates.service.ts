import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import { feeItemName } from '../../common/enums';
import { ResolvedAccess } from '../access/access.service';
import { scopeCommunityIds } from '../access/scope.util';
import { todayInTz } from './report.util';
import { AssignTemplateDto, LegacyTemplateImportDto, SaveTemplateDto, TemplateListDto, TemplateScopeDto } from './fee-templates.dto';
import { normalizeOverrides, normalizeTemplateItems, resolveTemplateItems, standardSignature, TemplateItem } from './fee-templates.util';

type Queryable = Pick<EntityManager,'query'>;
const kindSql = `(CASE WHEN EXISTS(SELECT 1 FROM houses kh JOIN buildings kb ON kb.id=kh.building_id WHERE kb.community_id=c.id AND kh.tenant_id=c.tenant_id AND kh.property_type='公寓') THEN 'apartment' ELSE 'residential' END)`;

@Injectable()
export class FeeTemplatesService {
  constructor(private readonly db: DataSource) {}
  private tenant(user: AuthUser) {
    if (!user.tenantId) throw new ForbiddenException('请选择物业公司');
    return user.tenantId;
  }
  private date(value: string) {
    const parsed=new Date(`${value}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0,10)!==value) throw new BadRequestException('生效日期无效');
    if (value < todayInTz(new Date())) throw new BadRequestException('新配置不能追溯改价，请选择今天或之后的生效日期');
  }
  private async scope(dto: TemplateScopeDto,user:AuthUser,access?:ResolvedAccess,q:Queryable=this.db) {
    const tenantId=this.tenant(user), allowed=scopeCommunityIds(access);
    if (allowed && !allowed.includes(dto.communityId)) throw new ForbiddenException('无权管理该门店或小区');
    const rows=await q.query(`SELECT c.id,c.name,${kindSql} kind FROM communities c WHERE c.tenant_id=$1 AND c.id=$2`,[tenantId,dto.communityId]);
    if (!rows.length) throw new NotFoundException('门店或小区不存在');
    if (rows[0].kind!==dto.kind) throw new BadRequestException('公寓与小区标准不能跨类别使用');
    return tenantId;
  }
  async communities(user:AuthUser,access?:ResolvedAccess) {
    const tenantId=this.tenant(user), allowed=scopeCommunityIds(access);
    if (allowed && !allowed.length) return [];
    return this.db.query(`SELECT c.id,c.name,${kindSql} kind FROM communities c WHERE c.tenant_id=$1 AND c.enabled=true
      AND ($2::int[] IS NULL OR c.id=ANY($2::int[])) AND EXISTS(SELECT 1 FROM buildings b JOIN houses h ON h.building_id=b.id WHERE b.community_id=c.id AND h.tenant_id=$1) ORDER BY c.id`,[tenantId,allowed]);
  }
  async list(dto:TemplateScopeDto,user:AuthUser,access?:ResolvedAccess) {
    const tenantId=await this.scope(dto,user,access);
    const templates=await this.db.query(`SELECT t.*,COALESCE((SELECT count(DISTINCT house_id) FROM (
      (SELECT DISTINCT ON(house_id) house_id,template_id FROM fee_template_assignments WHERE tenant_id=t.tenant_id AND community_id=t.community_id ORDER BY house_id,effective_from DESC,id DESC)
      UNION (SELECT DISTINCT ON(house_id) house_id,template_id FROM fee_template_assignments WHERE tenant_id=t.tenant_id AND community_id=t.community_id AND effective_from<=$4 ORDER BY house_id,effective_from DESC,id DESC)) a WHERE a.template_id=t.id),0)::int assigned_count
      FROM fee_templates t WHERE t.tenant_id=$1 AND t.community_id=$2 AND t.kind=$3 ORDER BY t.enabled DESC,t.id`,[tenantId,dto.communityId,dto.kind,todayInTz(new Date())]);
    const versions=templates.length?await this.db.query(`SELECT id,template_id,version,to_char(effective_from,'YYYY-MM-DD') effective_from,items FROM fee_template_versions WHERE template_id=ANY($1::int[]) ORDER BY version DESC`,[templates.map((t:any)=>t.id)]):[];
    for(const template of templates) template.versions=versions.filter((v:any)=>v.template_id===template.id);
    const buildings=await this.db.query(`SELECT b.id,b.building_no,b.lane FROM buildings b WHERE b.tenant_id=$1 AND b.community_id=$2 ORDER BY b.id`,[tenantId,dto.communityId]);
    return {templates,buildings};
  }
  async houses(dto:TemplateListDto,user:AuthUser,access?:ResolvedAccess) {
    const tenantId=await this.scope(dto,user,access);
    const page=dto.page??1;
    const base=`FROM houses h JOIN buildings b ON b.id=h.building_id
      LEFT JOIN LATERAL(SELECT * FROM fee_template_assignments a WHERE a.tenant_id=$1 AND a.house_id=h.id ORDER BY a.effective_from DESC,a.id DESC LIMIT 1) a ON true
      LEFT JOIN fee_templates t ON t.id=a.template_id
      LEFT JOIN LATERAL(SELECT name FROM users WHERE tenant_id=$1 AND house_id=h.id AND role='owner' ORDER BY id DESC LIMIT 1) u ON true
      WHERE h.tenant_id=$1 AND b.community_id=$2 AND b.building_no<>'公共区域'
      AND ($3::int IS NULL OR b.id=$3) AND ($4='' OR h.room_no ILIKE '%'||$4||'%' OR COALESCE(u.name,'') ILIKE '%'||$4||'%')
      AND ($5='all' OR ($5='unassigned' AND a.id IS NULL) OR ($5='override' AND a.overrides<>'{}'::jsonb))`;
    const params=[tenantId,dto.communityId,dto.buildingId??null,dto.q?.trim()??'',dto.filter??'all'];
    const [{count}]=await this.db.query(`SELECT count(*)::int count ${base}`,params);
    const rows=await this.db.query(`SELECT h.id,h.room_no,b.building_no,b.lane,u.name owner_name,a.template_id,t.name template_name,a.overrides,to_char(a.effective_from,'YYYY-MM-DD') effective_from,
      EXISTS(SELECT 1 FROM fee_standards s WHERE s.tenant_id=$1 AND s.house_id=h.id AND s.community_id=$2 AND s.status='active') has_legacy_standard ${base} ORDER BY b.id,h.id LIMIT 50 OFFSET $6`,[...params,(page-1)*50]);
    return {rows,total:count,page,pageSize:50};
  }
  async save(dto:SaveTemplateDto,user:AuthUser,access?:ResolvedAccess,id?:number) {
    this.date(dto.effectiveFrom);
    const items=normalizeTemplateItems(dto.items);
    if (!dto.name.trim()) throw new BadRequestException('请填写模板名称');
    return this.db.transaction(async manager=>{
      const tenantId=await this.scope(dto,user,access,manager);
      await manager.query(`SELECT pg_advisory_xact_lock($1,$2)`,[tenantId,dto.communityId]);
      const duplicates=await manager.query(`SELECT id FROM fee_templates WHERE tenant_id=$1 AND community_id=$2 AND kind=$3 AND name=$4 AND ($5::int IS NULL OR id<>$5)`,[tenantId,dto.communityId,dto.kind,dto.name.trim(),id??null]);
      if(duplicates.length) throw new ConflictException('当前门店已有同名模板，请使用不同名称');
      let template;
      if(id) {
        [template]=await manager.query(`SELECT * FROM fee_templates WHERE id=$1 AND tenant_id=$2 AND community_id=$3 AND kind=$4 FOR UPDATE`,[id,tenantId,dto.communityId,dto.kind]);
        if(!template) throw new NotFoundException('模板不存在');
        if(!template.enabled) throw new BadRequestException('模板已停用');
        if(dto.expectedRevision!==template.revision) throw new ConflictException('模板已被修改，请刷新后重试');
        const [{last_date}]=await manager.query(`SELECT to_char(max(effective_from),'YYYY-MM-DD') last_date FROM fee_template_versions WHERE template_id=$1`,[id]);
        if(dto.effectiveFrom<last_date) throw new BadRequestException('已有更晚生效的版本，请选择相同或更晚日期，避免覆盖调价安排');
        // 不允许删去仍被个别住户覆盖的项目，避免后续计费隐式丢失。
        const overrides=await manager.query(`SELECT overrides FROM ((SELECT DISTINCT ON(house_id) house_id,template_id,overrides FROM fee_template_assignments WHERE tenant_id=$1 AND community_id=$2 ORDER BY house_id,effective_from DESC,id DESC)
          UNION (SELECT DISTINCT ON(house_id) house_id,template_id,overrides FROM fee_template_assignments WHERE tenant_id=$1 AND community_id=$2 AND effective_from<=$4 ORDER BY house_id,effective_from DESC,id DESC)) a WHERE template_id=$3`,[tenantId,dto.communityId,id,todayInTz(new Date())]);
        overrides.forEach((row:any)=>normalizeOverrides(row.overrides,items));
        const [previousVersion]=await manager.query(`SELECT items FROM fee_template_versions WHERE template_id=$1 ORDER BY version DESC LIMIT 1`,[id]);
        for(const row of overrides) for(const code of Object.keys(row.overrides)) {
          const before=previousVersion.items.find((item:TemplateItem)=>item.feeCode===code),after=items.find(item=>item.feeCode===code)!;
          if(before && (before.unit!==after.unit || before.calculation!==after.calculation || before.cycle!==after.cycle)) throw new BadRequestException(`项目${feeItemName(code)}仍有住户个别调整，请先清除调整再改变计费方式或单位`);
        }
        [template]=await manager.query(`UPDATE fee_templates SET name=$1,revision=revision+1,updated_by=$2,updated_at=now() WHERE id=$3 RETURNING *`,[dto.name.trim(),user.id,id]);
      } else [template]=await manager.query(`INSERT INTO fee_templates(tenant_id,community_id,kind,name,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$5) RETURNING *`,[tenantId,dto.communityId,dto.kind,dto.name.trim(),user.id]);
      await manager.query(`INSERT INTO fee_template_versions(template_id,version,effective_from,items,created_by) VALUES($1,$2,$3,$4::jsonb,$5)`,[template.id,template.revision,dto.effectiveFrom,JSON.stringify(items),user.id]);
      return {id:template.id,version:template.revision};
    });
  }
  async disable(id:number,dto:TemplateScopeDto,user:AuthUser,access?:ResolvedAccess) {
    return this.db.transaction(async manager=>{
      const tenantId=await this.scope(dto,user,access,manager);
      await manager.query(`SELECT pg_advisory_xact_lock($1,$2)`,[tenantId,dto.communityId]);
      const [template]=await manager.query(`SELECT id FROM fee_templates WHERE id=$1 AND tenant_id=$2 AND community_id=$3 AND kind=$4 FOR UPDATE`,[id,tenantId,dto.communityId,dto.kind]);
      if(!template) throw new NotFoundException('模板不存在');
      const [{count}]=await manager.query(`SELECT count(DISTINCT house_id)::int count FROM ((SELECT DISTINCT ON(house_id) house_id,template_id FROM fee_template_assignments WHERE tenant_id=$1 AND community_id=$2 ORDER BY house_id,effective_from DESC,id DESC)
        UNION (SELECT DISTINCT ON(house_id) house_id,template_id FROM fee_template_assignments WHERE tenant_id=$1 AND community_id=$2 AND effective_from<=$4 ORDER BY house_id,effective_from DESC,id DESC)) a WHERE template_id=$3`,[tenantId,dto.communityId,id,todayInTz(new Date())]);
      if(count) throw new BadRequestException(`仍有${count}户使用该模板，请先批量更换模板`);
      await manager.query(`UPDATE fee_templates SET enabled=false,updated_by=$1,updated_at=now() WHERE id=$2`,[user.id,id]);
      return {ok:true};
    });
  }
  async assign(dto:AssignTemplateDto,user:AuthUser,access?:ResolvedAccess) {
    this.date(dto.effectiveFrom);
    if(dto.overrides && (dto.all || dto.houseIds?.length!==1)) throw new BadRequestException('个别调整只能选择一个住户');
    return this.db.transaction(async manager=>{
      const tenantId=await this.scope(dto,user,access,manager);
      await manager.query(`SELECT pg_advisory_xact_lock($1,$2)`,[tenantId,dto.communityId]);
      const [template]=await manager.query(`SELECT * FROM fee_templates WHERE id=$1 AND tenant_id=$2 AND community_id=$3 AND kind=$4 AND enabled=true FOR UPDATE`,[dto.templateId,tenantId,dto.communityId,dto.kind]);
      if(!template) throw new BadRequestException('所选模板不属于当前门店或已停用');
      if(template.revision!==dto.expectedRevision) throw new ConflictException('模板价格已变化，请刷新后重新确认');
      const [version]=await manager.query(`SELECT items FROM fee_template_versions WHERE template_id=$1 AND effective_from<=$2 ORDER BY effective_from DESC,version DESC LIMIT 1`,[template.id,dto.effectiveFrom]);
      if(!version) throw new BadRequestException('该模板在套用日期尚未生效');
      if(!dto.all && !dto.houseIds?.length) throw new BadRequestException('请选择住户');
      const houses=await manager.query(`SELECT h.id,h.area_sqm FROM houses h JOIN buildings b ON b.id=h.building_id WHERE h.tenant_id=$1 AND b.community_id=$2 AND b.building_no<>'公共区域' AND ($3::int IS NULL OR b.id=$3) AND ($4::int[] IS NULL OR h.id=ANY($4::int[])) ORDER BY h.id FOR UPDATE OF h`,[tenantId,dto.communityId,dto.buildingId??null,dto.all?null:dto.houseIds]);
      if(!houses.length || houses.length>5000) throw new BadRequestException('套用范围应为1—5000户，请按楼栋分批');
      if(houses.length!==dto.expectedCount) throw new ConflictException('套用范围户数已变化，请重新预览确认');
      if(!dto.all && houses.length!==new Set(dto.houseIds).size) throw new BadRequestException('所选房号不属于当前门店或楼栋，未保存');
      const previous=await manager.query(`SELECT DISTINCT ON(house_id) *,to_char(effective_from,'YYYY-MM-DD') date_text FROM fee_template_assignments WHERE tenant_id=$1 AND house_id=ANY($2::int[]) ORDER BY house_id,effective_from DESC,id DESC`,[tenantId,houses.map((h:any)=>h.id)]);
      const previousByHouse=new Map<number,any>(previous.map((row:any)=>[row.house_id,row]));
      const changes:Array<{house_id:number;overrides:Record<string,number>}>=[];
      for(const house of houses) {
        const old=previousByHouse.get(house.id);
        const overrides=normalizeOverrides(dto.overrides??(dto.preserveOverrides!==false?old?.overrides??{}:{}),version.items);
        resolveTemplateItems(version.items,overrides,house.area_sqm);
        if(old?.template_id===dto.templateId && old.date_text===dto.effectiveFrom && JSON.stringify(old.overrides)===JSON.stringify(overrides)) continue;
        changes.push({house_id:house.id,overrides});
      }
      if(changes.length) await manager.query(`INSERT INTO fee_template_assignments(tenant_id,community_id,house_id,template_id,effective_from,overrides,created_by)
        SELECT $1,$2,r.house_id,$3,$4,r.overrides,$5 FROM jsonb_to_recordset($6::jsonb) r(house_id int,overrides jsonb)`,[tenantId,dto.communityId,dto.templateId,dto.effectiveFrom,user.id,JSON.stringify(changes)]);
      return {changed:changes.length,total:houses.length};
    });
  }
  /** 在业务使用日期选择绑定与不可变价格版本。不能读未来价格，也不复制模板到逐户标准。 */
  async resolve(tenantId:number,houseId:number,date:string,q:Queryable=this.db) {
    const [row]=await q.query(`SELECT a.id assignment_id,a.template_id,a.overrides,v.version,v.items,to_char(v.effective_from,'YYYY-MM-DD') effective_from,h.area_sqm
      FROM fee_template_assignments a JOIN fee_templates t ON t.id=a.template_id AND t.tenant_id=a.tenant_id AND t.community_id=a.community_id
      JOIN houses h ON h.id=a.house_id AND h.tenant_id=a.tenant_id
      JOIN LATERAL(SELECT * FROM fee_template_versions WHERE template_id=t.id AND effective_from<=$3 ORDER BY effective_from DESC,version DESC LIMIT 1) v ON true
      WHERE a.tenant_id=$1 AND a.house_id=$2 AND a.effective_from<=$3 ORDER BY a.effective_from DESC,a.id DESC LIMIT 1`,[tenantId,houseId,date]);
    if(!row) return null;
    return {...row,items:resolveTemplateItems(row.items,row.overrides,row.area_sqm)};
  }
  async currentStandards(tenantId:number,houseId:number,date:string,q:Queryable=this.db) {
    const resolved=await this.resolve(tenantId,houseId,date,q);
    if(!resolved) return null;
    return resolved.items.map((item:any)=>({id:null,houseId,feeCode:item.feeCode,feeName:feeItemName(item.feeCode),amountCents:item.amountCents,standardCents:item.originalStandardCents??item.amountCents,status:'active',effectiveFrom:resolved.effective_from,effectiveTo:null,templateId:resolved.template_id,templateVersion:resolved.version,assignmentId:resolved.assignment_id,calculation:item.calculation,cycle:item.cycle,unit:item.unit,isOverride:item.isOverride}));
  }
  async generationStandards(tenantId:number,communityId:number,date:string,feeCode?:string):Promise<{coveredHouseIds:Set<number>;standards:any[]}> {
    const rows=await this.db.query(`SELECT a.house_id,a.template_id,a.overrides,a.id assignment_id,v.version,v.items,h.area_sqm
      FROM (SELECT DISTINCT ON(house_id) * FROM fee_template_assignments WHERE tenant_id=$1 AND community_id=$2 AND effective_from<=$3 ORDER BY house_id,effective_from DESC,id DESC) a
      JOIN houses h ON h.id=a.house_id AND h.tenant_id=$1 JOIN buildings b ON b.id=h.building_id AND b.community_id=$2
      JOIN LATERAL(SELECT version,items FROM fee_template_versions WHERE template_id=a.template_id AND effective_from<=$3 ORDER BY effective_from DESC,version DESC LIMIT 1) v ON true`,[tenantId,communityId,date]);
    const standards:any[]=[];
    for(const row of rows) for(const item of resolveTemplateItems(row.items,row.overrides,row.area_sqm)) {
      if(item.cycle!=='month' || item.calculation==='quantity' || item.amountCents<=0 || (feeCode && item.feeCode!==feeCode)) continue;
      standards.push({id:null,houseId:row.house_id,communityId,feeCode:item.feeCode,feeName:feeItemName(item.feeCode),amountCents:item.amountCents,
        templateSnapshot:{templateId:row.template_id,version:row.version,assignmentId:row.assignment_id,item}});
    }
    return {coveredHouseIds:new Set(rows.map((row:any)=>row.house_id)),standards};
  }
  async legacyPreview(dto:TemplateScopeDto,user:AuthUser,access?:ResolvedAccess,q:Queryable=this.db) {
    const tenantId=await this.scope(dto,user,access,q);
    const rows=await q.query(`SELECT s.id,s.house_id,s.fee_code,s.amount_cents,s.standard_cents FROM fee_standards s JOIN houses h ON h.id=s.house_id AND h.tenant_id=s.tenant_id JOIN buildings b ON b.id=h.building_id
      WHERE s.tenant_id=$1 AND s.community_id=$2 AND b.community_id=$2 AND s.status='active' AND s.effective_from<=$3 AND (s.effective_to IS NULL OR s.effective_to>=$3)
      AND NOT EXISTS(SELECT 1 FROM fee_template_assignments a WHERE a.tenant_id=$1 AND a.house_id=s.house_id) ORDER BY s.house_id,s.fee_code,s.id LIMIT 100001`,[tenantId,dto.communityId,todayInTz(new Date())]);
    if(rows.length>100000) throw new BadRequestException('旧标准过多，请联系管理员分批迁移');
    const grouped=new Map<number,TemplateItem[]>();
    const units:Record<string,string>={electricity:'度',hot_water:'吨',cold_water:'吨',deposit:'次'};
    for(const row of rows) {
      const items=grouped.get(row.house_id)??[];
      const quantity=dto.kind==='apartment' && ['electricity','hot_water','cold_water'].includes(row.fee_code);
      items.push({feeCode:row.fee_code,unitPriceCents:row.amount_cents,originalStandardCents:row.standard_cents,unit:dto.kind==='apartment'?units[row.fee_code]??'月':'月',calculation:quantity?'quantity':'fixed',cycle:quantity||row.fee_code==='deposit'?'once':'month'});
      grouped.set(row.house_id,items);
    }
    const groups=new Map<string,{items:TemplateItem[];houseIds:number[]}>();
    for(const [houseId,items] of grouped) {
      const checked=normalizeTemplateItems(items),signature=standardSignature(checked);
      const group=groups.get(signature)??{items:checked,houseIds:[]};group.houseIds.push(houseId);groups.set(signature,group);
    }
    return {fingerprint:createHash('sha256').update(JSON.stringify(rows)).digest('hex'),houses:grouped.size,groups:[...groups.values()]};
  }
  async importLegacy(dto:LegacyTemplateImportDto,user:AuthUser,access?:ResolvedAccess) {
    this.date(dto.effectiveFrom);
    return this.db.transaction(async manager=>{
      const tenantId=await this.scope(dto,user,access,manager);
      await manager.query(`SELECT pg_advisory_xact_lock($1,$2)`,[tenantId,dto.communityId]);
      const preview=await this.legacyPreview(dto,user,access,manager);
      if(preview.fingerprint!==dto.fingerprint) throw new ConflictException('标准或住户套用情况已变化，请重新预览');
      for(const [index,group] of preview.groups.entries()) {
        const key=createHash('sha256').update(standardSignature(group.items)).digest('hex');
        let [template]=await manager.query(`SELECT * FROM fee_templates WHERE tenant_id=$1 AND community_id=$2 AND kind=$3 AND legacy_group_key=$4`,[tenantId,dto.communityId,dto.kind,key]);
        if(!template) {
          [template]=await manager.query(`INSERT INTO fee_templates(tenant_id,community_id,kind,name,legacy_group_key,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$6) RETURNING *`,[tenantId,dto.communityId,dto.kind,`原标准模板 ${index+1} (${key.slice(0,6)})`,key,user.id]);
          await manager.query(`INSERT INTO fee_template_versions(template_id,version,effective_from,items,created_by) VALUES($1,1,$2,$3::jsonb,$4)`,[template.id,dto.effectiveFrom,JSON.stringify(group.items),user.id]);
        } else {
          const [current]=await manager.query(`SELECT items,to_char(effective_from,'YYYY-MM-DD') effective_from FROM fee_template_versions WHERE template_id=$1 ORDER BY version DESC LIMIT 1`,[template.id]);
          if(!template.enabled || standardSignature(current.items)!==standardSignature(group.items) || current.effective_from>dto.effectiveFrom) throw new ConflictException('原分组模板已改变或尚未生效，请手工选择模板套用');
        }
        await manager.query(`INSERT INTO fee_template_assignments(tenant_id,community_id,house_id,template_id,effective_from,created_by) SELECT $1,$2,unnest($3::int[]),$4,$5,$6`,[tenantId,dto.communityId,group.houseIds,template.id,dto.effectiveFrom,user.id]);
      }
      return {templates:preview.groups.length,houses:preview.houses};
    });
  }
}
