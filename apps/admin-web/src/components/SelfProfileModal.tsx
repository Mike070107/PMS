import { Alert, App, Button, Form, Input, Modal, Radio, Spin } from 'antd';
import { useEffect, useState } from 'react';
import { auth as authApi } from '@pms/api-client';
import type { SelfProfile } from '@pms/api-client/src/endpoints/auth';

export default function SelfProfileModal({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [profile, setProfile] = useState<SelfProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [qr, setQr] = useState<{ ticket: string; image: string; until: number } | null>(null);
  const [proof, setProof] = useState('');
  const [verifyMode, setVerifyMode] = useState<'password' | 'wechat'>('password');
  const [pendingValues, setPendingValues] = useState<{ phone: string; newPassword?: string } | null>(null);
  useEffect(() => {
    if (!open) { setProof(''); setQr(null); setPendingValues(null); return; }
    let active = true; setLoading(true); setError(''); setProfile(null); form.resetFields();
    authApi.selfProfile().then(value => { if (active) { setProfile(value); setVerifyMode(value.hasPassword ? 'password' : 'wechat'); form.setFieldsValue({ phone: value.phone || '' }); } })
      .catch(e => { if (active) setError(e.message || '资料读取失败'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [open, form]);
  useEffect(() => {
    if (!open || !qr) return;
    let active = true; let busy = false;
    const timer = window.setInterval(async () => {
      if (!active || busy) return;
      if (Date.now() > qr.until) { setError('身份确认二维码已过期，请重新生成'); setQr(null); return; }
      busy = true;
      try {
        const result = await authApi.qrLoginStatus(qr.ticket);
        if (!active) return;
        if (result.status === 'confirmed' && result.accessToken) {
          setProof(result.accessToken); setError('');
          if (pendingValues) {
            setSaving(true);
            try {
              await authApi.updateSelfProfile({ ...pendingValues, verificationToken: result.accessToken });
              if (active) { message.success('微信确认修改成功，授权不变，请重新登录。'); onSaved(); }
            } catch (e) { if (active) setError(e instanceof Error ? e.message : '修改失败，输入已保留'); }
            finally { if (active) { setSaving(false); setQr(null); } }
          }
        }
        else if (result.status === 'expired' || result.status === 'cancelled') { setQr(null); setError('身份确认已取消或过期，请重新生成'); }
      } catch (e) { if (active) { setError(e instanceof Error ? e.message : '身份确认失败'); setQr(null); } }
      finally { busy = false; }
    }, 1500);
    return () => { active = false; window.clearInterval(timer); };
  }, [open, qr, pendingValues]);
  const verifyWechat = async () => {
    const values = await form.validateFields().catch(() => null); if (!values) return;
    setPendingValues({ phone: values.phone, newPassword: values.newPassword || undefined });
    setError(''); setProof('');
    try { const ticket = await authApi.selfProfileVerification(); setQr({ ticket: ticket.ticket, image: ticket.qrImage, until: Date.now() + ticket.expiresIn * 1000 }); }
    catch (e) { setError(e instanceof Error ? e.message : '二维码生成失败'); }
  };
  const save = async () => {
    if (saving || !profile) return;
    const values = await form.validateFields().catch(() => null); if (!values) return;
    setSaving(true); setError('');
    try {
      await authApi.updateSelfProfile({ phone: values.phone, currentPassword: verifyMode === 'password' ? values.currentPassword : undefined, newPassword: values.newPassword || undefined, verificationToken: verifyMode === 'wechat' ? proof || undefined : undefined });
      message.success('电话和密码已保存，授权角色不变。请重新登录；下次微信扫码将核对新号码。'); onSaved();
    } catch (e) { setError(e instanceof Error ? e.message : '保存失败'); }
    finally { setSaving(false); }
  };
  return <Modal title="修改电话和密码" open={open} onCancel={() => { if (!saving) onClose(); }} onOk={() => void save()} okText="保存并重新登录" confirmLoading={saving} okButtonProps={{ disabled: loading || !profile || !!qr || (verifyMode === 'wechat' && !proof) }} destroyOnClose>
    <Alert type="info" showIcon message="仅修改本人电话和密码，姓名、角色与授权范围不变。" description="电话变更后，下次微信扫码登录需重新授权手机号，并与新电话一致。" />
    {error && <Alert style={{ marginTop: 12 }} type="error" showIcon message={error} />}
    {loading ? <Spin /> : profile && <Form form={form} layout="vertical" disabled={saving || !!qr} style={{ marginTop: 16 }}>
      <Form.Item label="确认修改的方式"><Radio.Group value={verifyMode} onChange={event => { setVerifyMode(event.target.value); setProof(''); setQr(null); setPendingValues(null); }}><Radio.Button value="password" disabled={!profile.hasPassword}>验证当前密码</Radio.Button><Radio.Button value="wechat">微信扫码确认修改</Radio.Button></Radio.Group></Form.Item>
      <Form.Item label="电话" name="phone" rules={[{ required: true, message: '请输入电话' }, { pattern: /^1[3-9]\d{9}$/, message: '请输入11位中国大陆手机号' }]}><Input inputMode="tel" maxLength={11} autoComplete="tel" /></Form.Item>
      {verifyMode === 'password' && <Form.Item label="当前密码" name="currentPassword" rules={[{ required: true, message: '请输入当前密码验证本人身份' }]}><Input.Password autoComplete="current-password" maxLength={128} /></Form.Item>}
      <Form.Item label="新密码（留空保持原密码）" name="newPassword" rules={[{ min: 8, message: '新密码至少8位' }, { max: 128, message: '新密码最多128位' }]}><Input.Password autoComplete="new-password" maxLength={128} /></Form.Item>
      <Form.Item label="确认新密码" name="confirmPassword" dependencies={['newPassword']} rules={[({ getFieldValue }) => ({ validator(_, value) { return (value || '') === (getFieldValue('newPassword') || '') ? Promise.resolve() : Promise.reject(new Error('两次输入的新密码不一致')); } })]}><Input.Password autoComplete="new-password" maxLength={128} /></Form.Item>
      {verifyMode === 'wechat' && <div><Button onClick={() => void verifyWechat()} disabled={!!qr || saving}>生成确认修改二维码</Button>{qr && <div><img src={qr.image} alt="微信确认修改二维码" style={{ width: 200, maxWidth: '100%' }} /><p>请用本人微信扫码并确认，确认后将保存本次填写的电话和密码。</p></div>}</div>}
    </Form>}
  </Modal>;
}
