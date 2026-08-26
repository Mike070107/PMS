import {
  App as AntdApp,
  Alert,
  Button,
  Card,
  Input,
  InputNumber,
  Skeleton,
  Space,
  Switch,
  Typography,
} from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { request } from '../lib/api';
import { usePagePerm } from '../lib/auth';

const { Title, Text, Paragraph } = Typography;

interface TenantSettings {
  ownerPhoneAutoMatch: { enabled: boolean };
  wxSubscribeTemplates: {
    orderDispatched: string;
    orderReview: string;
    /** 员工端模板：有新工单派给维修工 */
    orderAssigned: string;
  };
  autoReview: { hours: number };
}

type TemplateKey = 'orderDispatched' | 'orderReview' | 'orderAssigned';

interface TemplateResult {
  ok: boolean;
  appType?: 'owner' | 'staff';
  error?: string;
  errcode?: number;
  /** 每个关键词会被填成什么 */
  fields?: { key: string; label: string; from: string; value: string }[];
  remaining?: number;
  /** 这条结果是「校验」还是「测试发送」 */
  kind: 'check' | 'test';
}

const FIELD_FROM_LABEL: Record<string, string> = {
  orderNo: '工单编号',
  type: '报修类型',
  status: '工单状态',
  content: '报修内容',
  assignee: '维修工',
  address: '报修地址',
  time: '时间',
};

interface MatchableStat {
  ownersWithPhoneAndHouse: number;
  housesTotal: number;
}

export default function SettingsPage() {
  const { message } = AntdApp.useApp();
  const { canEdit } = usePagePerm('settings');

  const [settings, setSettings] = useState<TenantSettings | null>(null);
  const [stat, setStat] = useState<MatchableStat | null>(null);
  const [saving, setSaving] = useState(false);
  const [tplDispatched, setTplDispatched] = useState('');
  const [tplReview, setTplReview] = useState('');
  const [tplAssigned, setTplAssigned] = useState('');
  const [savingTpl, setSavingTpl] = useState(false);
  /** 每个模板的校验/测试结果，就地显示在输入框下面 */
  const [tplResult, setTplResult] = useState<Record<string, TemplateResult | null>>({});
  const [tplBusy, setTplBusy] = useState<string>('');
  const [autoReviewHours, setAutoReviewHours] = useState(48);
  const [savingAutoReview, setSavingAutoReview] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await request<TenantSettings>({ url: '/settings' });
      setSettings(next);
      setTplDispatched(next.wxSubscribeTemplates?.orderDispatched || '');
      setTplReview(next.wxSubscribeTemplates?.orderReview || '');
      setTplAssigned(next.wxSubscribeTemplates?.orderAssigned || '');
      setAutoReviewHours(next.autoReview?.hours ?? 48);
    } catch (e: any) {
      message.error(e?.message || '加载设置失败');
    }
    // 有多少业主档案真的能被匹配上——开关开了却匹配不到人是最常见的困惑
    try {
      setStat(await request<MatchableStat>({ url: '/settings/phone-match-stat' }));
    } catch {
      setStat(null);
    }
  }, [message]);

  useEffect(() => {
    load();
  }, [load]);

  const togglePhoneMatch = async (enabled: boolean) => {
    setSaving(true);
    try {
      const next = await request<TenantSettings>({
        method: 'PATCH',
        url: '/settings',
        data: { ownerPhoneAutoMatch: { enabled } },
      });
      setSettings(next);
      message.success(enabled ? '已开启手机号快速识别' : '已关闭');
    } catch (e: any) {
      message.error(e?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const checkTemplate = async (template: TemplateKey, templateId: string) => {
    setTplBusy(`check:${template}`);
    try {
      const r = await request<Omit<TemplateResult, 'kind'>>({
        method: 'POST',
        url: '/notifications/templates/check',
        data: { template, templateId: templateId.trim() || undefined },
      });
      setTplResult((prev) => ({ ...prev, [template]: { ...r, kind: 'check' } }));
    } catch (e: any) {
      setTplResult((prev) => ({ ...prev, [template]: { ok: false, error: e?.message || '校验失败', kind: 'check' } }));
    } finally {
      setTplBusy('');
    }
  };

  const testTemplate = async (template: TemplateKey) => {
    setTplBusy(`test:${template}`);
    try {
      const r = await request<Omit<TemplateResult, 'kind'>>({
        method: 'POST',
        url: '/notifications/templates/test',
        data: { template },
      });
      setTplResult((prev) => ({ ...prev, [template]: { ...r, kind: 'test' } }));
      if (r.ok) message.success('已发出，看看微信有没有收到');
    } catch (e: any) {
      setTplResult((prev) => ({ ...prev, [template]: { ok: false, error: e?.message || '发送失败', kind: 'test' } }));
    } finally {
      setTplBusy('');
    }
  };

  const saveTemplates = async () => {
    setSavingTpl(true);
    try {
      const next = await request<TenantSettings>({
        method: 'PATCH',
        url: '/settings',
        data: {
          wxSubscribeTemplates: {
            orderDispatched: tplDispatched.trim(),
            orderReview: tplReview.trim(),
            orderAssigned: tplAssigned.trim(),
          },
        },
      });
      setSettings(next);
      message.success('已保存，下一条通知立即生效');
    } catch (e: any) {
      message.error(e?.message || '保存失败');
    } finally {
      setSavingTpl(false);
    }
  };

  const saveAutoReview = async () => {
    setSavingAutoReview(true);
    try {
      const next = await request<TenantSettings>({
        method: 'PATCH',
        url: '/settings',
        data: { autoReview: { hours: autoReviewHours } },
      });
      setSettings(next);
      setAutoReviewHours(next.autoReview.hours);
      message.success('自动验收时限已保存，现有待验收工单也按新时限执行');
    } catch (e: any) {
      message.error(e?.message || '保存失败');
    } finally {
      setSavingAutoReview(false);
    }
  };

  return (
    <div>
      <Title level={4} style={{ marginTop: 0 }}>系统设置</Title>

      <Card title="微信订阅消息" style={{ maxWidth: 760, marginBottom: 24 }}>
        <Paragraph style={{ marginBottom: 8 }}>
          填了模板 ID，业主就能在<Text strong>微信里收到「已派单」「修好了待验收」的提醒</Text>、
          维修工能收到<Text strong>「有新工单派给你」</Text>；留空则只写站内消息。
        </Paragraph>
        <Paragraph type="secondary" style={{ fontSize: 13, marginBottom: 8 }}>
          模板在<Text strong>微信公众平台 → 订阅消息 → 我的模板</Text>里申请或从公共模板库选用，
          把模板 ID 复制过来即可。<Text strong>关键词随便选</Text>（比如「工单状态 / 报单内容 / 提醒时间」），
          系统发送时会按关键词的意思自动填内容 —— 点「校验」能看到每个关键词会被填成什么。
          同一个模板可以三处都填。
        </Paragraph>
        <Paragraph type="warning" style={{ fontSize: 13 }}>
          模板不能跨小程序用：前两个要在<Text strong>业主端（邻修管家）</Text>里申请，
          「新工单派给维修工」要在<Text strong>员工端（邻修管理）</Text>里申请。
          填错了「校验」会直接告诉你。
        </Paragraph>
        <Space direction="vertical" size={16} style={{ width: '100%', marginTop: 8 }}>
          {(
            [
              { key: 'orderDispatched' as TemplateKey, label: '已派单通知业主', app: '业主端', value: tplDispatched, set: setTplDispatched },
              { key: 'orderReview' as TemplateKey, label: '待验收通知业主', app: '业主端', value: tplReview, set: setTplReview },
              { key: 'orderAssigned' as TemplateKey, label: '新工单派给维修工', app: '员工端', value: tplAssigned, set: setTplAssigned },
            ]
          ).map((row) => {
            const result = tplResult[row.key];
            return (
              <div key={row.key}>
                <Text strong>{row.label}</Text>
                <Text type="secondary" style={{ marginLeft: 8, fontSize: 13 }}>{row.app}小程序的模板</Text>
                <Space.Compact block style={{ marginTop: 6 }}>
                  <Input
                    value={row.value}
                    onChange={(e) => row.set(e.target.value)}
                    placeholder="从公众平台复制模板 ID"
                    disabled={!canEdit}
                    allowClear
                  />
                  <Button
                    loading={tplBusy === `check:${row.key}`}
                    disabled={!row.value.trim()}
                    onClick={() => checkTemplate(row.key, row.value)}
                  >
                    校验
                  </Button>
                  {canEdit && (
                    <Button
                      loading={tplBusy === `test:${row.key}`}
                      disabled={!row.value.trim() || row.value.trim() !== (settings?.wxSubscribeTemplates?.[row.key] || '')}
                      title={row.value.trim() !== (settings?.wxSubscribeTemplates?.[row.key] || '') ? '先保存再测' : undefined}
                      onClick={() => testTemplate(row.key)}
                    >
                      发我一条测试
                    </Button>
                  )}
                </Space.Compact>
                {result && (
                  <Alert
                    style={{ marginTop: 8 }}
                    type={result.ok ? 'success' : 'error'}
                    showIcon
                    message={
                      result.ok
                        ? result.kind === 'test'
                          ? `已发出（这个模板你还剩 ${result.remaining ?? 0} 条额度）`
                          : '模板可用，发送时会这样填：'
                        : result.error
                    }
                    description={
                      result.fields?.length ? (
                        <div style={{ fontSize: 13, lineHeight: 1.8 }}>
                          {result.fields.map((f) => (
                            <div key={f.key}>
                              <Text strong>{f.label || f.key}</Text>
                              <Text type="secondary"> ← {FIELD_FROM_LABEL[f.from] || f.from}：</Text>
                              {f.value}
                            </div>
                          ))}
                        </div>
                      ) : undefined
                    }
                  />
                )}
              </div>
            );
          })}
          {canEdit && (
            <Button type="primary" loading={savingTpl} onClick={saveTemplates}>
              保存模板 ID
            </Button>
          )}
        </Space>
      </Card>

      <Card title="工单自动验收" style={{ maxWidth: 760, marginBottom: 24 }}>
        <Paragraph>
          维修工提交完工后，业主未在设定时间内验收，系统将自动完成工单并记录
          <Text strong>“系统自动验收”</Text>。建议保持 48～72 小时。
        </Paragraph>
        <Space align="center" wrap>
          <Text strong>等待时限</Text>
          <InputNumber
            min={1}
            max={720}
            precision={0}
            value={autoReviewHours}
            disabled={!canEdit}
            onChange={(value) => setAutoReviewHours(value ?? 48)}
            addonAfter="小时"
          />
          {canEdit && (
            <Button
              type="primary"
              loading={savingAutoReview}
              onClick={saveAutoReview}
            >
              保存时限
            </Button>
          )}
        </Space>
        <Paragraph type="secondary" style={{ fontSize: 13, marginTop: 12, marginBottom: 0 }}>
          修改后立即生效；已经处于待验收状态的工单也会使用新的租户时限。
        </Paragraph>
      </Card>

      <Card title="业主手机号快速识别" style={{ maxWidth: 760 }}>
        {!settings ? (
          <Skeleton active paragraph={{ rows: 2 }} />
        ) : (
          <>
            <Space align="start" style={{ width: '100%', justifyContent: 'space-between' }}>
              <div style={{ flex: 1, paddingRight: 24 }}>
                <Paragraph style={{ marginBottom: 8 }}>
                  开启后，业主在小程序里授权微信手机号，系统会去房产档案里找同号业主，
                  <Text strong>直接把地址带进报修单</Text>，不用扫码也不用填房号。
                </Paragraph>
                <Paragraph type="secondary" style={{ fontSize: 13, marginBottom: 0 }}>
                  匹配<Text strong>不会自动建立绑定关系</Text>——房产档案里的电话可能是上一任业主留的，
                  自动绑定会把房子绑错人。要正式绑定仍然走「认证房屋 + 物业审核」。
                  匹配不到时，业主回落到扫码带出的楼栋，只需填室号或商铺号。
                </Paragraph>
              </div>
              <Switch
                checked={settings.ownerPhoneAutoMatch.enabled}
                loading={saving}
                disabled={!canEdit}
                onChange={togglePhoneMatch}
              />
            </Space>

            {!canEdit && (
              <Alert
                type="info"
                showIcon
                style={{ marginTop: 16 }}
                message="当前账号没有修改设置的权限，仅可查看"
              />
            )}

            {stat && stat.ownersWithPhoneAndHouse === 0 && (
              <Alert
                type="warning"
                showIcon
                style={{ marginTop: 16 }}
                message="现在开启也匹配不到任何人"
                description={
                  <>
                    房产档案里有 {stat.housesTotal} 套房，但
                    <Text strong>没有一条同时登记了业主手机号和房产</Text>。
                    需要先在「房产与业主 → 业主」里补齐业主姓名和手机号（或用导入功能批量导），
                    这个开关才有意义。
                  </>
                }
              />
            )}
            {stat && stat.ownersWithPhoneAndHouse > 0 && (
              <Alert
                type="success"
                showIcon
                style={{ marginTop: 16 }}
                message={`当前有 ${stat.ownersWithPhoneAndHouse} 位业主登记了手机号并绑定了房产，可被匹配`}
              />
            )}
          </>
        )}
      </Card>
    </div>
  );
}
