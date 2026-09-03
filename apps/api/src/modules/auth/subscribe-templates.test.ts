import assert from 'node:assert/strict';
import test from 'node:test';
import bcrypt from 'bcryptjs';
import { UserRole, UserStatus } from '../../common/enums';
import { AuthService } from './auth.service';

test('员工端同时下发新单、催接单、办公室催修模板并去重', async () => {
  const service = Object.create(AuthService.prototype) as any;
  service.settings = {
    async getSettingsByTenant() {
      return {
        wxSubscribeTemplates: {
          orderDispatched: 'owner-dispatched',
          orderReview: 'owner-review',
          orderAssigned: 'staff-new',
          orderOverdue: 'staff-overdue',
          orderUrge: 'staff-new',
        },
      };
    },
  };

  assert.deepEqual(await service.resolveSubscribeTemplates(1, 'staff'), [
    'staff-new',
    'staff-overdue',
  ]);
  assert.deepEqual(await service.resolveSubscribeTemplates(1, 'owner'), [
    'owner-dispatched',
    'owner-review',
  ]);
});

test('只有配置的审核账号可以跳过微信绑定', () => {
  const service = Object.create(AuthService.prototype) as any;
  service.config = {
    get(_key: string, fallback: string) {
      return fallback;
    },
  };

  assert.equal(service.isMiniappReviewAccount('testadmin'), true);
  assert.equal(service.isMiniappReviewAccount(' TestAdmin '), true);
  assert.equal(service.isMiniappReviewAccount('admin'), false);

  service.config = {
    get() {
      return 'wx-review-1, wx-review-2';
    },
  };
  assert.equal(service.isMiniappReviewAccount('testadmin'), false);
  assert.equal(service.isMiniappReviewAccount('WX-REVIEW-2'), true);
});

test('审核账号密码正确时不请求微信 openid，也不写入绑定', async () => {
  const service = Object.create(AuthService.prototype) as any;
  const user = {
    id: 7,
    loginAccount: 'testadmin',
    passwordHash: await bcrypt.hash('review-pass', 4),
    role: UserRole.STAFF,
    status: UserStatus.ACTIVE,
    wxOpenid: null,
  };
  service.config = { get: (_key: string, fallback: string) => fallback };
  service.userRepo = {
    findOne: async () => user,
    save: async () => {
      throw new Error('审核账号不应写入微信绑定');
    },
  };
  service.wechat = {
    jscode2session: async () => {
      throw new Error('审核账号不应请求微信 openid');
    },
  };
  service.logger = { log: () => undefined };
  service.issueStaffTokens = async (target: typeof user) => ({ userId: target.id });

  assert.deepEqual(
    await service.staffLogin({ code: 'unused', account: 'testadmin', password: 'review-pass' }),
    { userId: 7 },
  );
  assert.equal(user.wxOpenid, null);
});
