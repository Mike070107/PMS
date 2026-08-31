import { useEffect, useRef, useState } from 'react';
import { App as AntdApp, Button, Modal, Space, Typography } from 'antd';
import { MobileOutlined } from '@ant-design/icons';
import { auth } from '../lib/auth';
import { SignatureCanvas, type SignatureCanvasHandle } from './SignatureCanvas';

const { Text } = Typography;
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api/v1';

/**
 * 电脑上的手写签名弹窗。画布本身在 SignatureCanvas 里，和手机签名页共用一份。
 *
 * 鼠标签出来的字都不好看，所以右下角常备一个「发到手机签」——
 * 由调用方接上二维码那套（见 MaintenanceOrdersPage 的 PhoneSignModal）。
 */
export function SignaturePad({
  open,
  title,
  hint,
  confirmText = '确认签名',
  onCancel,
  onDone,
  onSendToPhone,
}: {
  open: boolean;
  title: string;
  hint?: string;
  confirmText?: string;
  onCancel: () => void;
  /** 上传完成后回调签名图片地址 */
  onDone: (url: string) => void | Promise<void>;
  /** 给了就显示「发到手机签」按钮 */
  onSendToPhone?: () => void;
}) {
  const { message } = AntdApp.useApp();
  const padRef = useRef<SignatureCanvasHandle | null>(null);
  const [empty, setEmpty] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setEmpty(true);
  }, [open]);

  const save = async () => {
    const blob = await padRef.current?.toPngBlob();
    if (!blob) {
      message.error('请先手写签名');
      return;
    }
    setSaving(true);
    try {
      const url = await uploadSignature(blob);
      await onDone(url);
    } catch (e: any) {
      message.error(e?.message || '签名保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      title={title}
      width={720}
      onCancel={onCancel}
      destroyOnHidden
      footer={
        <Space wrap>
          {onSendToPhone && (
            <Button size="large" icon={<MobileOutlined />} onClick={onSendToPhone} disabled={saving}>
              发到手机签
            </Button>
          )}
          <Button size="large" onClick={() => padRef.current?.clear()} disabled={empty || saving}>
            清空
          </Button>
          <Button size="large" onClick={() => padRef.current?.undo()} disabled={empty || saving}>
            撤销一笔
          </Button>
          <Button size="large" onClick={onCancel} disabled={saving}>
            取消
          </Button>
          <Button size="large" type="primary" loading={saving} onClick={save} disabled={empty}>
            {confirmText}
          </Button>
        </Space>
      }
    >
      <Text type="secondary" style={{ display: 'block', marginBottom: 12, lineHeight: 1.6 }}>
        {hint || '在下面的框里手写姓名。鼠标不好写就点「发到手机签」，微信扫码在手机上签。'}
      </Text>
      {open && <SignatureCanvas ref={padRef} onEmptyChange={setEmpty} />}
    </Modal>
  );
}

async function uploadSignature(blob: Blob): Promise<string> {
  const form = new FormData();
  form.append('file', blob, `signature-${Date.now()}.png`);
  const headers: Record<string, string> = {};
  const token = auth.getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const acting = auth.getActingTenant();
  if (acting) headers['x-acting-tenant-id'] = String(acting.id);
  const res = await fetch(`${API_BASE_URL}/upload`, { method: 'POST', headers, body: form });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.message || `签名上传失败（HTTP ${res.status}）`);
  }
  const body = await res.json();
  const payload = body && typeof body === 'object' && 'code' in body ? body.data : body;
  const url = payload?.displayUrl || payload?.publicUrl;
  if (!url) throw new Error('签名上传失败：服务端没有返回图片地址');
  return url as string;
}
