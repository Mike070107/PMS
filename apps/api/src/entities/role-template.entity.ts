import { Entity, Column, Index } from 'typeorm';
import { TenantEntity } from '../common/base.entity';

/**
 * 权限模板 = 一组勾好的页面权限，不含数据范围、不能分配给人。
 *
 * 为什么要有它：几个管理处的「物业办公室」权限完全一样，只是数据范围不同。
 * 没有模板时每建一个都要把整片勾选重来一遍（会漏），之后要改一格权限
 * 得进每个角色改一遍（更会漏）。角色 `roles.template_id` 指过来之后，
 * 权限只有这一份出处，改模板立刻对所有跟随它的角色生效，
 * 配角色的人只需要填名字和数据范围。
 *
 * 故意没有「启用/停用」：停用一个正被跟随的模板，那些角色的权限该怎么算
 * 说不清楚（清空 = 悄悄把一批人挡在门外）。被引用时不允许删除即可。
 */
@Entity('role_templates')
@Index(['tenantId', 'name'], { unique: true })
export class RoleTemplate extends TenantEntity {
  @Column({ type: 'varchar', length: 60 })
  name: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  remark: string | null;
}
