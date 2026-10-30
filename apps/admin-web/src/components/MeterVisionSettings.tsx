import { Alert, App, AutoComplete, Button, Form, Input, InputNumber, Space, Switch, Typography } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { request } from '../lib/api';

export interface MeterVisionSetting {
  enabled: boolean;
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
}
const DEFAULTS: MeterVisionSetting = { enabled: false,
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen3-vl-plus', apiKey: '', timeoutMs: 15000 };
const endpoint = (value: string) => value.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
const MODELS = [
  { value: 'qwen3-vl-plus', label: 'Qwen3-VL-Plus · 六张样图中表现较好' },
  { value: 'qwen-vl-ocr', label: 'Qwen-VL-OCR · 文字提取' },
  { value: 'qwen3.5-ocr', label: 'Qwen3.5-OCR · 待现场验证' },
];

export default function MeterVisionSettings({ initial, canEdit, onSaved }: {
  initial?: MeterVisionSetting; canEdit: boolean; onSaved: (value: MeterVisionSetting) => void;
}) {
  const [form] = Form.useForm<MeterVisionSetting>();
  const { message } = App.useApp();
  const [saved, setSaved] = useState<MeterVisionSetting>(initial || DEFAULTS);
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const testing = useRef(false);
  useEffect(() => {
    if (initial && !form.isFieldsTouched()) {
      setSaved(initial);
      form.setFieldsValue({ ...initial, apiKey: '' });
    }
  }, [initial, form]);
  const enabled = Form.useWatch('enabled', form);
  const baseUrl = Form.useWatch('baseUrl', form) || '';
  const keyRetained = !!saved.apiKey && endpoint(baseUrl) === endpoint(saved.baseUrl);
  const focusFirst = (name: string) => {
    form.scrollToField(name, { block: 'center' });
    form.getFieldInstance(name)?.focus?.();
  };
  const submit = async (kind: 'save' | 'test') => {
    if (busy || !canEdit) return;
    testing.current = kind === 'test';
    let values: MeterVisionSetting;
    try { values = await form.validateFields(); }
    catch (error: any) { const field = error?.errorFields?.[0]?.name?.[0]; if (field) focusFirst(field); return; }
    setBusy(kind); setResult(null);
    try {
      if (kind === 'save') {
        const response = await request<{ meterVision: MeterVisionSetting }>({ method: 'PATCH', url: '/settings', data: { meterVision: values } });
        setSaved(response.meterVision);
        form.setFieldsValue({ ...response.meterVision, apiKey: '' });
        onSaved(response.meterVision);
        message.success('抄表图像识别设置已保存');
      } else {
        const response = await request<{ ok: boolean; model?: string; elapsedMs?: number; error?: string }>({
          method: 'POST', url: '/settings/ai/meter-vision/test', data: values, timeout: values.timeoutMs + 5000,
        });
        setResult({ ok: response.ok, message: response.ok
          ? `${response.model} 已正确识别测试图片，用时 ${((response.elapsedMs || 0) / 1000).toFixed(2)} 秒。此测试不代表现场读表准确率。`
          : response.error || '测试图片未能正确识别，请检查模型和接口配置' });
      }
    } catch (error: any) {
      const text = error?.message || '请求失败，填写内容已保留';
      const field = text.startsWith('API Key') ? 'apiKey' : text.startsWith('接口地址') ? 'baseUrl' : text.startsWith('模型') ? 'model' : '';
      if (field) { form.setFields([{ name: field, errors: [text] }]); focusFirst(field); }
      else setResult({ ok: false, message: text });
    } finally { setBusy(null); testing.current = false; }
  };
  return <>
    <Typography.Paragraph>只识别红框内裁切并扶正后的图片，全景原图单独留档。读数需人工确认，滚动字轮等纠正会进入候选样本池。</Typography.Paragraph>
    <Form form={form} layout="vertical" initialValues={DEFAULTS} disabled={!canEdit || !!busy}
      onValuesChange={() => setResult(null)} requiredMark scrollToFirstError>
      <Form.Item name="enabled" label="启用抄表图像识别" valuePropName="checked"><Switch checkedChildren="开启" unCheckedChildren="关闭" /></Form.Item>
      <Form.Item name="model" label="识别模型" required rules={[{ required: true, whitespace: true, message: '请选择或填写支持图片输入的模型' }]} extra="可选择常用模型，也可填写接口支持的其他视觉模型名称。">
        <AutoComplete options={MODELS} allowClear aria-label="识别模型" />
      </Form.Item>
      <Form.Item name="baseUrl" label="接口地址" required rules={[{ required: true, whitespace: true, message: '请填写接口地址' }, { validator: (_, value) => {
        try { const url = new URL(value); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
          if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error(); return Promise.resolve();
        } catch { return Promise.reject(new Error('请填写 HTTPS 接口地址，本机测试可用 HTTP')); }
      } }]} extra="百炼需使用与 API Key 所属地域一致的接口地址。可填写到 /v1。"><Input allowClear autoComplete="url" /></Form.Item>
      <Form.Item name="apiKey" label="API Key" dependencies={['enabled', 'baseUrl']} rules={[{ validator: (_, value) =>
        (testing.current || form.getFieldValue('enabled')) && !value?.trim() && !keyRetained
          ? Promise.reject(new Error('请填写当前接口对应的 API Key')) : Promise.resolve() }]} extra={keyRetained
          ? `已保存密钥 ${saved.apiKey}，留空保持；切换模型可继续使用。`
          : saved.apiKey ? '接口地址已改变，请填写对应服务的密钥。' : '密钥仅在服务端保存，读取时脱敏。'}>
        <Input.Password autoComplete="new-password" placeholder={keyRetained ? '留空保持已保存密钥' : '填写 API Key'} />
      </Form.Item>
      <Form.Item name="timeoutMs" label="识别超时（毫秒）" rules={[{ required: true, message: '请填写识别超时' }, { type: 'number', min: 1000, max: 60000, message: '识别超时应为1000～60000毫秒' }]} extra="超时后保留原图和已输入读数，可重试或手工填写。"><InputNumber min={1000} max={60000} step={1000} style={{ width: '100%' }} /></Form.Item>
      {canEdit && <Space wrap>
        <Button type="primary" loading={busy === 'save'} disabled={!!busy} onClick={() => void submit('save')}>保存抄表设置</Button>
        <Button loading={busy === 'test'} disabled={!!busy} onClick={() => void submit('test')}>测试图像识别</Button>
      </Space>}
      {!enabled && <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>保存关闭后停止调用抄表 AI，仍可拍照留档并人工填写读数。</Typography.Paragraph>}
      {result && <Alert style={{ marginTop: 16 }} showIcon type={result.ok ? 'success' : 'error'} message={result.message} />}
    </Form>
  </>;
}
