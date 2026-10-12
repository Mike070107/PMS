import assert from 'node:assert/strict';
import test from 'node:test';
import bcrypt from 'bcryptjs';
import { AuthService } from './auth.service';
import { QrLoginService } from './qr-login.service';
import { JwtStrategy } from './jwt.strategy';
import { UserStatus } from '../../common/enums';
import { WebLoginTicketStatus, WebLoginTicketPurpose } from '../../entities/web-login-ticket.entity';

async function fixture() {
  const account: any = { id: 7, tenantId: 3, status: UserStatus.ACTIVE, phone: '13800000001', name: '原姓名', role: 'manager', passwordHash: await bcrypt.hash('old-pass-123', 4) };
  const writes: any[] = [];
  const service = Object.create(AuthService.prototype) as any;
  service.selfProfileAttempts = new Map();
  service.userRepo = { findOne: async ({ where }: any) => where.id === 7 ? account : null,
    update: async (_where: any, patch: any) => { writes.push(patch); Object.assign(account, patch); return { affected: 1 }; } };
  service.jwt = { verify: () => ({ sub: 7, iat: Math.floor(Date.now() / 1000), authMethod: 'wechat', typ: 'self_profile' }) };
  return { service, account, writes };
}
test('本人电话密码更新仅写允许列，保留姓名角色并要求重新验证手机号', async () => {
  const f = await fixture();
  await f.service.updateSelfProfile(7, { currentPassword: 'old-pass-123', phone: '13900000002', newPassword: 'new-pass-456', role: 'superadmin', name: '不可修改' });
  assert.equal(f.account.role, 'manager'); assert.equal(f.account.name, '原姓名');
  assert.equal(f.account.phoneReverificationRequired, true);
  assert.ok(await bcrypt.compare('new-pass-456', f.account.passwordHash));
  assert.deepEqual(Object.keys(f.writes[0]).sort(), ['credentialVersion', 'passwordHash', 'phone', 'phoneReverificationRequired', 'updatedBy'].sort());
});
test('错误旧密码、他人微信证明不得写入，电话未变不触发重验', async () => {
  const f = await fixture();
  await assert.rejects(f.service.updateSelfProfile(7, { currentPassword: 'wrong', phone: '13900000002' }), /当前密码/);
  assert.equal(f.writes.length, 0);
  await f.service.updateSelfProfile(7, { currentPassword: 'old-pass-123', phone: f.account.phone });
  assert.equal(f.writes[0].phoneReverificationRequired, undefined);
  f.account.passwordHash = null; f.service.jwt.verify = () => ({ sub: 9, iat: Math.floor(Date.now() / 1000), authMethod: 'wechat', typ: 'self_profile' });
  await assert.rejects(f.service.updateSelfProfile(7, { verificationToken: 'proof', newPassword: 'new-pass-456' }), /不是本人/);
});
test('手机号变更后旧扫码会话不能绕过，微信实际号码匹配后才签发登录', async () => {
  const f = await fixture(); f.account.phoneReverificationRequired = true;
  const qr = Object.create(QrLoginService.prototype) as any;
  qr.assertRateLimit = () => {}; qr.assertStaffApp = () => {};
  qr.requireUsableTicket = async () => ({ id: 1, status: WebLoginTicketStatus.SCANNED, scannedByUserId: 7, purpose: WebLoginTicketPurpose.ADMIN });
  qr.userRepo = f.service.userRepo;
  qr.wechat = { getPhoneNumber: async () => '13900000002' };
  let issued = 0;
  qr.authService = { issueWebTokensForUser: async () => { issued++; } };
  qr.ticketRepo = { update: async () => ({ affected: 1 }) };
  await assert.rejects(qr.confirm('ticket', { id: 7 }), /重新授权微信手机号/);
  await assert.rejects(qr.confirm('ticket', { id: 7 }, 'wx-code'), /不一致/);
  assert.equal(issued, 0);
  qr.wechat.getPhoneNumber = async () => f.account.phone;
  await qr.confirm('ticket', { id: 7 }, 'wx-code');
  assert.equal(issued, 1); assert.equal(f.account.phoneReverificationRequired, false);
});

test('修改电话或密码后旧访问令牌和刷新令牌失效，原角色不变', async () => {
  const f = await fixture(); f.account.credentialVersion = 1;
  const strategy = Object.create(JwtStrategy.prototype) as any;
  strategy.userRepo = f.service.userRepo;
  await assert.rejects(strategy.validate({ headers: {} }, { sub: 7, role: 'manager', credentialVersion: 0 }), /重新登录/);
  f.service.refreshSecret = () => 'test';
  f.service.jwt.verify = () => ({ sub: 7, typ: 'refresh', credentialVersion: 0 });
  await assert.rejects(f.service.refresh({ refreshToken: 'old' }), /重新登录/);
});

test('重复电话和过期微信证明均不写入；无密码可用本人新鲜扫码证明设置密码', async () => {
  const f = await fixture();
  const originalFind = f.service.userRepo.findOne;
  f.service.userRepo.findOne = async (options: any) => options.where.phone ? { id: 9 } : originalFind(options);
  await assert.rejects(f.service.updateSelfProfile(7, { currentPassword: 'old-pass-123', phone: '13900000002' }), /其他账号/);
  assert.equal(f.writes.length, 0);
  f.service.userRepo.findOne = originalFind; f.account.passwordHash = null;
  f.service.jwt.verify = () => ({ sub: 7, iat: Math.floor(Date.now() / 1000) - 181, authMethod: 'wechat', typ: 'self_profile' });
  await assert.rejects(f.service.updateSelfProfile(7, { verificationToken: 'old' }), /过期/);
  f.service.jwt.verify = () => ({ sub: 7, iat: Math.floor(Date.now() / 1000), authMethod: 'wechat', typ: 'self_profile' });
  await f.service.updateSelfProfile(7, { verificationToken: 'fresh', newPassword: 'first-pass-123' });
  assert.ok(await bcrypt.compare('first-pass-123', f.account.passwordHash));
});

test('已有密码也可选择本人微信证明确认修改，不要求同时输入旧密码', async () => {
  const f = await fixture();
  await f.service.updateSelfProfile(7, { verificationToken: 'fresh', phone: '13900000002' });
  assert.equal(f.account.phone, '13900000002');
  assert.equal(f.account.role, 'manager');
});

test('资料修改证明不能充当登录令牌；他人不能扫描本人的修改二维码', async () => {
  const strategy = Object.create(JwtStrategy.prototype) as any;
  await assert.rejects(strategy.validate({ headers: {} }, { sub: 7, typ: 'self_profile' }), /不能用于登录/);
  const qr = Object.create(QrLoginService.prototype) as any;
  qr.assertRateLimit = () => {}; qr.assertStaffApp = () => {};
  qr.requireUsableTicket = async () => ({ id: 1, userId: 7, status: WebLoginTicketStatus.PENDING, purpose: WebLoginTicketPurpose.SELF_PROFILE });
  await assert.rejects(qr.markScanned('ticket', { id: 9 }), /本人/);
});

test('旧小程序静默微信登录不能绕过变更电话；微信手机号登录匹配后完成重验', async () => {
  const f = await fixture(); f.account.phoneReverificationRequired = true; f.account.wxOpenid = 'wx-user';
  f.service.wechat = { jscode2session: async () => ({ openid: 'wx-user' }), getPhoneNumber: async () => f.account.phone };
  f.service.userRepo.findOne = async () => f.account;
  f.service.userRepo.find = async () => [f.account];
  f.service.userRepo.save = async (value: any) => value;
  f.service.issueStaffTokens = async () => ({ ok: true });
  await assert.rejects(f.service.staffLogin({ code: 'wx-code' }), /重新授权微信手机号/);
  await f.service.staffLogin({ code: 'wx-code', phoneCode: 'phone-code' });
  assert.equal(f.account.phoneReverificationRequired, false);
  assert.equal(f.account.role, 'manager');
});
