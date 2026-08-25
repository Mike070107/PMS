import { Card, Form, Input, Button, App as AntdApp, Typography, Tabs, Spin } from 'antd';
import { LockOutlined, QrcodeOutlined, ReloadOutlined, UserOutlined } from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { auth as authApi } from '@pms/api-client';
import type { AdminLoginResp } from '@pms/api-client/src/endpoints/auth';
import { auth } from '../lib/auth';
import { useCallback, useEffect, useRef, useState } from 'react';
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

  /**
   * 登录成功后的收尾。账号密码和扫码两条路都要走这一份 ——
   * 漏拉一次权限清单，菜单会整片消失（access 为空按无权限处理）。
   */
  const finishLogin = useCallback(
    async (accessToken: string, user: AdminLoginResp['user']) => {
      auth.setSession(accessToken, user);
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
    },
    [message, nav, sp],
  );

  const onFinish = async (values: { account: string; password: string }) => {
    setLoading(true);
    try {
      const r = await authApi.adminLogin(values);
      await finishLogin(r.accessToken, r.user);
    } catch (e: any) {
      message.error(e?.message || '登录失败');
    } finally {
      setLoading(false);
    }
  };

  const accountForm = (
    <Form layout="vertical" onFinish={onFinish} requiredMark={false} size="large">
      <Form.Item label="账号" name="account" rules={[{ required: true, message: '请输入账号' }]}>
        <Input
          autoComplete="username"
          placeholder="请输入登录账号"
          prefix={<UserOutlined style={{ color: '#94a3b8' }} />}
        />
      </Form.Item>
      <Form.Item label="密码" name="password" rules={[{ required: true, message: '请输入密码' }]}>
        <Input.Password
          autoComplete="current-password"
          placeholder="请输入密码"
          prefix={<LockOutlined style={{ color: '#94a3b8' }} />}
        />
      </Form.Item>
      <Button type="primary" htmlType="submit" loading={loading} block size="large" style={{ marginTop: 6 }}>
        登 录
      </Button>
    </Form>
  );

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
          <Text type="secondary" style={{ display: 'block', marginBottom: 14 }}>
            请使用物业分配的账号登录
          </Text>
          <Tabs
            defaultActiveKey="account"
            items={[
              {
                key: 'account',
                label: (
                  <span>
                    <UserOutlined /> 账号密码
                  </span>
                ),
                children: accountForm,
              },
              {
                key: 'qr',
                label: (
                  <span>
                    <QrcodeOutlined /> 微信扫码
                  </span>
                ),
                children: <QrLoginPanel onSuccess={finishLogin} />,
              },
            ]}
          />
        </Card>
      </main>
    </div>
  );
}

/**
 * 微信扫码登录面板。
 *
 * 出一张【邻修管理】的小程序码 → 本人扫开、在手机上点确认 → 这里轮询换到 token。
 *
 * 两分钟过期且**不自动续**：无人看管的电脑上挂一张一直有效的登录码，等于把后台
 * 入口摆在桌面上。要用就点一下刷新，这一步刻意留给人做。
 */
function QrLoginPanel({
  onSuccess,
}: {
  onSuccess: (accessToken: string, user: AdminLoginResp['user']) => Promise<void>;
}) {
  const [qrImage, setQrImage] = useState('');
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<'pending' | 'scanned' | 'expired' | 'cancelled'>('pending');
  const [errorMsg, setErrorMsg] = useState('');
  const timerRef = useRef<number | null>(null);
  /** 组件卸载后别再 setState，也别继续轮询 */
  const aliveRef = useRef(true);

  const stopPolling = () => {
    if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const load = useCallback(async () => {
    stopPolling();
    setLoading(true);
    setErrorMsg('');
    setStatus('pending');
    try {
      const t = await authApi.qrLoginTicket();
      if (!aliveRef.current) return;
      setQrImage(t.qrImage);
      setLoading(false);

      timerRef.current = window.setInterval(async () => {
        try {
          const r = await authApi.qrLoginStatus(t.ticket);
          if (!aliveRef.current) return;
          if (r.status === 'confirmed' && r.accessToken && r.user) {
            stopPolling();
            await onSuccess(r.accessToken, r.user);
            return;
          }
          if (r.status === 'expired' || r.status === 'cancelled') {
            stopPolling();
            setStatus(r.status);
            return;
          }
          // confirmed 但没带上 token 的情况上面已经过滤掉了；这里只剩等待中的两态
          if (r.status === 'pending' || r.status === 'scanned') setStatus(r.status);
        } catch {
          // 轮询失败不打断：多半只是一次网络抖动，下一轮还会再问
        }
      }, 2000);
    } catch (e: any) {
      if (!aliveRef.current) return;
      setLoading(false);
      // 微信的真实原因要露出来（小程序未发布、落地页不存在等）；
      // 只写一句「加载失败」的话，没人知道该去改什么
      setErrorMsg(e?.message || '二维码加载失败');
    }
  }, [onSuccess]);

  useEffect(() => {
    aliveRef.current = true;
    load();
    return () => {
      aliveRef.current = false;
      stopPolling();
    };
  }, [load]);

  const dead = status === 'expired' || status === 'cancelled';
  const hintText =
    status === 'scanned'
      ? '已扫码，请在手机上点「确认登录」'
      : status === 'cancelled'
        ? '你在手机上拒绝了这次登录'
        : status === 'expired'
          ? '二维码已过期'
          : '请用微信扫码，在【邻修管理】里确认';

  if (errorMsg) {
    return (
      <div style={{ textAlign: 'center', padding: '28px 12px' }}>
        <Text type="danger" style={{ display: 'block', marginBottom: 16, lineHeight: 1.7 }}>
          {errorMsg}
        </Text>
        <Button icon={<ReloadOutlined />} onClick={load}>
          重试
        </Button>
      </div>
    );
  }

  return (
    <div style={{ textAlign: 'center', padding: '8px 0 4px' }}>
      <div
        style={{
          position: 'relative',
          width: 200,
          height: 200,
          margin: '0 auto',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: '1px solid #e5e7eb',
          borderRadius: 12,
          overflow: 'hidden',
        }}
      >
        {loading ? (
          <Spin />
        ) : (
          <>
            <img
              src={qrImage}
              alt="微信扫码登录"
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'contain',
                filter: dead ? 'blur(3px)' : undefined,
              }}
            />
            {dead && (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  background: 'rgba(255,255,255,0.82)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Button type="primary" icon={<ReloadOutlined />} onClick={load}>
                  刷新二维码
                </Button>
              </div>
            )}
          </>
        )}
      </div>
      <Text
        type={status === 'scanned' ? undefined : 'secondary'}
        style={{ display: 'block', marginTop: 16, lineHeight: 1.7 }}
      >
        {hintText}
      </Text>
      <Text type="secondary" style={{ display: 'block', marginTop: 6, fontSize: 12, lineHeight: 1.7 }}>
        首次使用请先在【邻修管理】小程序用微信手机号登录一次；手机号需与管理员在
        「用户管理」里登记的一致。
      </Text>
    </div>
  );
}
