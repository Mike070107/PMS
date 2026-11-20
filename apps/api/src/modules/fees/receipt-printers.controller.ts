import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Param,
  ParseIntPipe,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CurrentUser, AuthUser } from '../../common/current-user.decorator';
import { CurrentAccess } from '../access/current-access.decorator';
import { ResolvedAccess } from '../access/access.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../access/permissions.guard';
import { RequirePermission } from '../../common/require-permission.decorator';
import {
  bearerToken,
  hashAgentToken,
  issueAgentSecret,
} from '../access-card-issuance/agent-auth';
import { FeesService } from './fees.service';
import { receiptLines } from './receipt-print-layout';

const cashierPages: Array<
  'apartment-cashier' | 'app:apartment-cashier' | 'fees'
> = ['apartment-cashier', 'app:apartment-cashier', 'fees'];
const online = "seen_at > now()-interval '25 seconds'";
function admin(user: AuthUser, access: ResolvedAccess) {
  if (!user.tenantId || !access.scopeAll || !access.isTenantAdmin)
    throw new ForbiddenException('需要企业管理员权限');
  return user.tenantId;
}
function secret(header: string) {
  const token = bearerToken(header);
  if (!/^[\w-]{43}$/.test(token))
    throw new UnauthorizedException('绑定凭据无效');
  return hashAgentToken(token);
}
@Controller('receipt-printers')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ReceiptPrintersController {
  constructor(
    private db: DataSource,
    private fees: FeesService,
  ) {}
  @Get('manage')
  @RequirePermission('business', 'edit')
  async manage(@CurrentUser() u: AuthUser, @CurrentAccess() a: ResolvedAccess) {
    const t = admin(u, a);
    const printers = await this.db.query(
      `SELECT p.id,name,queue_name,token_hash IS NOT NULL AS bound, ${online} AS online
       FROM receipt_printers p WHERE tenant_id=$1 ORDER BY id`,[t]);
    return {printers};
  }

  @Get('employees/:employeeId')
  @RequirePermission('users','edit')
  async employeePrinters(@Param('employeeId',ParseIntPipe) employeeId:number,@CurrentUser() u:AuthUser,@CurrentAccess() a:ResolvedAccess) {
    const tenant=admin(u,a);
    const [employee]=await this.db.query("SELECT id FROM users WHERE id=$1 AND tenant_id=$2 AND role='staff'",[employeeId,tenant]);
    if(!employee) throw new ForbiddenException();
    return this.db.query(`SELECT p.id,p.name,EXISTS(SELECT 1 FROM receipt_print_grants g WHERE g.printer_id=p.id AND g.employee_id=$2) AS allowed
      FROM receipt_printers p WHERE p.tenant_id=$1 ORDER BY p.name,p.id`,[tenant,employeeId]);
  }
  @Post('register')
  @RequirePermission('business', 'edit')
  async register(
    @CurrentUser() u: AuthUser,
    @CurrentAccess() a: ResolvedAccess,
    @Body('name') name: string,
  ) {
    const t = admin(u, a),
      key = issueAgentSecret();
    if (typeof name !== 'string' || !name.trim() || name.length > 60)
      throw new BadRequestException('请输入打印机名称（最多60字）');
    const [p] = await this.db.query(
      "INSERT INTO receipt_printers(tenant_id,name,pairing_hash,expires_at,created_by) VALUES($1,$2,$3,now()+interval '10 minutes',$4) ON CONFLICT(tenant_id,name) DO NOTHING RETURNING id",
      [t, name.trim(), key.tokenHash, u.id],
    );
    if (!p) throw new ConflictException('该打印机名称已登记，请在设备列表重新绑定');
    return { id: p.id, code: key.token };
  }
  @Post(':id/reset')
  @RequirePermission('business', 'edit')
  async reset(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() u: AuthUser,
    @CurrentAccess() a: ResolvedAccess,
  ) {
    const key = issueAgentSecret(),
      t = admin(u, a);
    await this.db.transaction(async (m) => {
      const rows = await m.query(
        "WITH p AS (UPDATE receipt_printers SET pairing_hash=$3,expires_at=now()+interval '10 minutes',token_hash=NULL,seen_at=NULL,queue_name=NULL WHERE id=$1 AND tenant_id=$2 RETURNING id) SELECT id FROM p",
        [id, t, key.tokenHash],
      );
      if (!rows.length) throw new ForbiddenException();
      await m.query(
        "UPDATE receipt_print_jobs SET state='cancelled' WHERE printer_id=$1 AND state='waiting'",
        [id],
      );
    });
    return { code: key.token };
  }
  @Post(':id/grants')
  @RequirePermission('users', 'edit')
  async grant(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() u: AuthUser,
    @CurrentAccess() a: ResolvedAccess,
    @Body() body: { employeeId: number; allow: boolean },
  ) {
    const t = admin(u, a);
    if (
      !Number.isSafeInteger(body?.employeeId) ||
      typeof body.allow !== 'boolean'
    )
      throw new BadRequestException();
    await this.db.transaction(async (m) => {
      if (
        !(
          await m.query(
            'SELECT id FROM receipt_printers WHERE id=$1 AND tenant_id=$2 FOR UPDATE',
            [id, t],
          )
        ).length
      )
        throw new ForbiddenException();
      if (body.allow) {
        if (
          !(
            await m.query(
              "SELECT id FROM users WHERE id=$1 AND tenant_id=$2 AND role='staff' AND status='active'",
              [body.employeeId, t],
            )
          ).length
        )
          throw new BadRequestException('请选择有效员工');
        await m.query(
          'INSERT INTO receipt_print_grants VALUES($1,$2) ON CONFLICT DO NOTHING',
          [id, body.employeeId],
        );
      } else {
        await m.query(
          'DELETE FROM receipt_print_grants WHERE printer_id=$1 AND employee_id=$2',
          [id, body.employeeId],
        );
        await m.query(
          "UPDATE receipt_print_jobs SET state='cancelled' WHERE printer_id=$1 AND employee_id=$2 AND state='waiting'",
          [id, body.employeeId],
        );
      }
    });
    return { ok: true };
  }
  @Get('mine')
  @RequirePermission(cashierPages, 'view')
  list(@CurrentUser() u: AuthUser) {
    return this.db.query(
      `SELECT p.id,p.name,coalesce(${online},false) AS online FROM receipt_printers p JOIN receipt_print_grants g ON g.printer_id=p.id WHERE tenant_id=$1 AND employee_id=$2 ORDER BY p.name,p.id`,
      [u.tenantId, u.id],
    );
  }
  @Post(':id/jobs')
  @RequirePermission(cashierPages, 'view')
  async enqueue(
    @Param('id', ParseIntPipe) id: number,
    @Body() b: { receiptNo: string; reprint: boolean; requestId: string },
    @CurrentUser() u: AuthUser,
    @CurrentAccess() a: ResolvedAccess,
  ) {
    if (
      !b ||
      typeof b.receiptNo !== 'string' ||
      !b.receiptNo ||
      b.receiptNo.length > 100 ||
      typeof b.reprint !== 'boolean' ||
      typeof b.requestId !== 'string' ||
      !/^[a-zA-Z0-9-]{12,80}$/.test(b.requestId)
    )
      throw new BadRequestException('无效的小票打印请求');
    const r = await this.fees.cashierReceipt(b.receiptNo, u, a),
      lines = receiptLines(r, b.reprint);
    return this.db.transaction(async (m) => {
      const [p] = await m.query(
        `SELECT p.id,${online} AS online FROM receipt_printers p JOIN receipt_print_grants g ON g.printer_id=p.id WHERE id=$1 AND tenant_id=$2 AND employee_id=$3 FOR UPDATE OF p`,
        [id, u.tenantId, u.id],
      );
      if (!p) throw new ForbiddenException('未获该打印机授权');
      await m.query('SELECT pg_advisory_xact_lock($1,hashtext($2))', [
        u.tenantId,
        b.receiptNo,
      ]);
      const [prior] = await m.query(
        'SELECT id,state,receipt_no,printer_id,reprint FROM receipt_print_jobs WHERE tenant_id=$1 AND employee_id=$2 AND request_id=$3',
        [u.tenantId, u.id, b.requestId],
      );
      if (prior) {
        if (
          prior.receipt_no !== b.receiptNo ||
          prior.printer_id !== id ||
          prior.reprint !== b.reprint
        )
          throw new ConflictException();
        return { id: prior.id, state: prior.state };
      }
      if (!p.online) throw new ConflictException('打印机离线，请检查现场助手');
      const [counts] = await m.query(
        "SELECT count(*) FILTER (WHERE NOT reprint)::int AS originals,count(*) FILTER (WHERE created_at>now()-interval '30 seconds' OR (state IN ('waiting','claimed') AND coalesce(claimed_at,created_at)>now()-interval '1 minute'))::int AS recent FROM receipt_print_jobs WHERE tenant_id=$1 AND receipt_no=$2",
        [u.tenantId, b.receiptNo],
      );
      if (!b.reprint && counts.originals)
        throw new ConflictException('已申请打印。如需另一份，请在记录中补打');
      if (counts.recent)
        throw new ConflictException('这张小票刚申请过打印，请先核对出纸');
      const [rate] = await m.query(
        "SELECT count(*)::int AS n FROM receipt_print_jobs WHERE printer_id=$1 AND created_at>now()-interval '1 minute'",
        [id],
      );
      if (rate.n >= 6) throw new ConflictException('打印较频繁，请稍后再试');
      const [job] = await m.query(
        'INSERT INTO receipt_print_jobs(printer_id,tenant_id,employee_id,receipt_no,request_id,reprint,lines) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,state',
        [
          id,
          u.tenantId,
          u.id,
          b.receiptNo,
          b.requestId,
          b.reprint,
          JSON.stringify(lines),
        ],
      );
      return job;
    });
  }
  @Get('jobs/:job')
  @RequirePermission(cashierPages, 'view')
  async status(
    @Param('job', ParseIntPipe) job: number,
    @CurrentUser() u: AuthUser,
  ) {
    const [r] = await this.db.query(
      "SELECT CASE WHEN state='waiting' AND created_at < now()-interval '1 minute' THEN 'expired' WHEN state='claimed' AND claimed_at < now()-interval '1 minute' THEN 'unknown' ELSE state END AS state FROM receipt_print_jobs WHERE id=$1 AND tenant_id=$2 AND employee_id=$3",
      [job, u.tenantId, u.id],
    );
    if (!r) throw new ForbiddenException();
    return r;
  }
}
@Controller('receipt-print-agent')
export class ReceiptPrintAgentController {
  constructor(private db: DataSource) {}
  @Post('bind')
  async bind(
    @Headers('authorization') auth: string,
    @Body('queue') queue: string,
  ) {
    if (typeof queue !== 'string' || !queue.trim() || queue.length > 160)
      throw new BadRequestException('请指定本机打印队列');
    const key = issueAgentSecret();
    const [p] = await this.db.query(
      'WITH p AS (UPDATE receipt_printers SET pairing_hash=NULL,expires_at=NULL,token_hash=$2,queue_name=$3 WHERE pairing_hash=$1 AND expires_at>now() RETURNING id) SELECT id FROM p',
      [secret(auth), key.tokenHash, queue],
    );
    if (!p) throw new UnauthorizedException('绑定码已失效，请重新生成');
    return { token: key.token };
  }
  @Post('next')
  async next(@Headers('authorization') auth: string) {
    return this.db.transaction(async (m) => {
      const [p] = await m.query(
        'WITH p AS (UPDATE receipt_printers SET seen_at=now() WHERE token_hash=$1 RETURNING id) SELECT id FROM p',
        [secret(auth)],
      );
      if (!p) throw new UnauthorizedException();
      const [job] = await m.query(
        `WITH j AS (UPDATE receipt_print_jobs SET state='claimed',claimed_at=now() WHERE id=(SELECT j.id FROM receipt_print_jobs j JOIN receipt_print_grants g ON g.printer_id=j.printer_id AND g.employee_id=j.employee_id JOIN users u ON u.id=j.employee_id AND u.tenant_id=j.tenant_id AND u.status='active' AND u.role='staff' WHERE j.printer_id=$1 AND state='waiting' AND created_at>now()-interval '1 minute' ORDER BY j.id LIMIT 1) RETURNING id,lines) SELECT * FROM j`,
        [p.id],
      );
      return { job: job || null };
    });
  }
  @Post('report')
  async report(
    @Headers('authorization') auth: string,
    @Body() b: { id: number; state: string },
  ) {
    if (
      !b ||
      !Number.isSafeInteger(b.id) ||
      !['spooled', 'unknown'].includes(b.state)
    )
      throw new BadRequestException();
    const [j] = await this.db.query(
      "WITH j AS (UPDATE receipt_print_jobs j SET state=$3 FROM receipt_printers p WHERE j.id=$1 AND j.printer_id=p.id AND p.token_hash=$2 AND j.state IN ('claimed',$3) RETURNING j.id) SELECT id FROM j",
      [b.id, secret(auth), b.state],
    );
    if (!j) throw new ForbiddenException();
    return { ok: true };
  }
}
