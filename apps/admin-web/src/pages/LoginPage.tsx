import { Card, Form, Input, Button, App as AntdApp, Typography } from 'antd';
import { LockOutlined, UserOutlined } from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { auth as authApi } from '@pms/api-client';
import { auth } from '../lib/auth';
import { useState } from 'react';
import BrandLogo from '../components/BrandLogo';

const { Text, Title } = Typography;

const VALUE_POINTS = [
  '报修工单闭环：业主扫码报修 → 派单 → 维修 → 验收全程留痕',
  '材料库存与采购审批：批次成本、分批到货、调拨确认',
  '前台收费：停车月租、门禁卡、物业费收缴一站办理',
  '多小区多租户隔离，权限按角色精细管控',
];

export default function LoginPage() {
  const { message } = AntdApp.useApp();
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const [loading, setLoading] = useState(false);

  const onFinish = async (values: { account: string; password: string }) => {
    setLoading(true);
    try {
      const r = await authApi.adminLogin(values);
      auth.setSession(r.accessToken, r.user);
      // 登录后立刻拉权限清单：菜单可见性、按钮显隐都靠它
      try {
        const meResp = (await authApi.me()) as { access?: import('@pms/shared-types').AdminAccess };
        auth.setAccess(meResp?.access ?? null);
      } catch {
        auth.setAccess(null);
      }
      message.success('登录成功');
      const next = sp.get('next');
      nav(next ? decodeURIComponent(next) : '/dashboard', { replace: true });
    } catch (e: any) {
      message.error(e?.message || '登录失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="pms-login">
      <aside className="pms-login-brandpane">
        <div>
          <BrandLogo dark size="large" />
          <div className="pms-login-headline">
            让每一次报修
            <br />
            都有着落、有回音
          </div>
          <p className="pms-login-sub">
            面向物业公司的一体化管理平台：报修工单、材料采购、库存调拨、
            前台收费与业主档案，全部在同一处闭环。
          </p>
          <div className="pms-login-points">
            {VALUE_POINTS.map((point) => (
              <div key={point} className="pms-login-point">
                <span className="dot" />
                <span>{point}</span>
              </div>
            ))}
          </div>
        </div>
        <Text style={{ color: 'rgba(241,245,249,0.42)', fontSize: 12 }}>
          © {new Date().getFullYear()} 邻修 · 社区维修与便民服务平台
        </Text>
      </aside>

      <main className="pms-login-formpane">
        <Card
          className="pms-login-card"
          variant="borderless"
          style={{ boxShadow: '0 20px 60px rgba(31, 41, 55, 0.12)', borderRadius: 14 }}
          styles={{ body: { padding: '36px 34px' } }}
        >
          <Title level={4} style={{ marginBottom: 4 }}>
            管理后台登录
          </Title>
          <Text type="secondary" style={{ display: 'block', marginBottom: 26 }}>
            请使用物业分配的账号登录
          </Text>
          <Form layout="vertical" onFinish={onFinish} requiredMark={false} size="large">
            <Form.Item
              label="账号"
              name="account"
              rules={[{ required: true, message: '请输入账号' }]}
            >
              <Input
                autoComplete="username"
                placeholder="请输入登录账号"
                prefix={<UserOutlined style={{ color: '#94a3b8' }} />}
              />
            </Form.Item>
            <Form.Item
              label="密码"
              name="password"
              rules={[{ required: true, message: '请输入密码' }]}
            >
              <Input.Password
                autoComplete="current-password"
                placeholder="请输入密码"
                prefix={<LockOutlined style={{ color: '#94a3b8' }} />}
              />
            </Form.Item>
            <Button
              type="primary"
              htmlType="submit"
              loading={loading}
              block
              size="large"
              style={{ marginTop: 6 }}
            >
              登 录
            </Button>
          </Form>
        </Card>
      </main>
    </div>
  );
}
