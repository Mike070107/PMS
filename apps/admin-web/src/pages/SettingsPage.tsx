import {
  App as AntdApp,
  Alert,
  Button,
  Card,
  Input,
  InputNumber,
  Select,
  Skeleton,
  Space,
  Switch,
  Typography,
} from 'antd';
import { RightOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import AiSamplesPanel from '../components/AiSamplesPanel';
import AiLearningPanel from '../components/AiLearningPanel';
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
    /** 员工端模板：超时还没人接单，催办 */
    orderOverdue: string;
    /** 员工端模板：办公室手动催修 */
    orderUrge: string;
  };
  autoReview: { hours: number };
  /** 超时催办：开关、时限、只在这个时段催 */
  dispatchEscalation: {
    enabled: boolean;
    acceptMinutes: number;
    startAt: string;
    endAt: string;
  };
  /** 服务号模板消息。appSecret 读回来是脱敏串，留空保存 = 不变 */
  wxServiceAccount: {
    appId: string;
    appSecret: string;
    templateOrderAssigned: string;
    enabled: boolean;
  };
  /** 大模型辅助识别。apiKey 读回来是脱敏串，留空保存 = 不变 */
  aiAssist: {
    enabled: boolean;
    baseUrl: string;
    model: string;
    apiKey: string;
    timeoutMs: number;
  };
}

type TemplateKey =
  | 'orderDispatched'
  | 'orderReview'
  | 'orderAssigned'
  | 'orderOverdue'
  | 'orderUrge';

/** 催办时段选到整点就够，用下拉比时间控件好点得多 */
const HOUR_OPTIONS = Array.from({ length: 24 }, (_, h) => {
  const v = `${String(h).padStart(2, '0')}:00`;
  return { value: v, label: v };
});

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
  reporter: '报修人',
  time: '提醒时间',
  reportedAt: '报修时间',
  dueAt: '要求完成截止',
};

interface MatchableStat {
  ownersWithPhoneAndHouse: number;
  housesTotal: number;
}

/**
 * 可折叠的设置卡片，**默认全部折叠**。
 *
 * 设置页是「偶尔进来改一件事」的地方，五张卡片全摊开要滚三四屏才找得到目标；
 * 折叠后一屏就能看完有哪些设置，点标题展开要改的那张。标题下留一行摘要，
 * 免得折叠状态只剩几个光秃秃的名词。
 *
 * 开关放在标题右侧（extra，不在可点区域里）：折叠时也能直接看状态、直接切，
 * 且点开关不会顺带把卡片展开。
 */
function SettingSection({
  title,
  summary,
  extra,
  children,
}: {
  title: string;
  summary: string;
  extra?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const toggle = () => setOpen((v) => !v);
  return (
    <Card
      className="pms-setting-card"
      style={{ maxWidth: 760, marginBottom: 16 }}
      styles={open ? undefined : { body: { display: 'none' } }}
      title={
        <div
          className="pms-setting-card__head"
          role="button"
          tabIndex={0}
          aria-expanded={open}
          onClick={toggle}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              toggle();
            }
          }}
        >
          <RightOutlined className="pms-setting-card__caret" data-open={open ? '1' : '0'} />
          <span className="pms-setting-card__text">
            <span>{title}</span>
            <span className="pms-setting-card__summary">{summary}</span>
          </span>
        </div>
      }
      extra={extra}
    >
      {open ? children : null}
    </Card>
  );
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
  const [tplOverdue, setTplOverdue] = useState('');
  const [tplUrge, setTplUrge] = useState('');
  const [savingTpl, setSavingTpl] = useState(false);
  /** 每个模板的校验/测试结果，就地显示在输入框下面 */
  const [tplResult, setTplResult] = useState<Record<string, TemplateResult | null>>({});
  const [tplBusy, setTplBusy] = useState<string>('');
  const [autoReviewHours, setAutoReviewHours] = useState(48);
  const [escalateMinutes, setEscalateMinutes] = useState(60);
  const [escalateEnabled, setEscalateEnabled] = useState(true);
  const [escalateStart, setEscalateStart] = useState('08:00');
  const [escalateEnd, setEscalateEnd] = useState('20:00');
  const [savingEscalate, setSavingEscalate] = useState(false);
  const [mp, setMp] = useState({
    appId: '',
    appSecret: '',
    templateOrderAssigned: '',
    enabled: false,
  });
  const [savingMp, setSavingMp] = useState(false);
  const [syncingMp, setSyncingMp] = useState(false);
  const [testingMp, setTestingMp] = useState(false);
  const [mpResult, setMpResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [savingAutoReview, setSavingAutoReview] = useState(false);
  /** 大模型辅助识别。apiKey 和服务号那份一样：回显脱敏串，原样交回 = 不改 */
  const [ai, setAi] = useState({
    enabled: false,
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
    apiKey: '',
    timeoutMs: 6000,
  });
  const [savingAi, setSavingAi] = useState(false);
  const [testingAi, setTestingAi] = useState(false);
  const [aiResult, setAiResult] = useState<{ ok: boolean; message: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await request<TenantSettings>({ url: '/settings' });
      setSettings(next);
      setTplDispatched(next.wxSubscribeTemplates?.orderDispatched || '');
      setTplReview(next.wxSubscribeTemplates?.orderReview || '');
      setTplAssigned(next.wxSubscribeTemplates?.orderAssigned || '');
      setTplOverdue(next.wxSubscribeTemplates?.orderOverdue || '');
      setTplUrge(next.wxSubscribeTemplates?.orderUrge || '');
      setAutoReviewHours(next.autoReview?.hours ?? 48);
      setEscalateMinutes(next.dispatchEscalation?.acceptMinutes ?? 60);
      setEscalateEnabled(next.dispatchEscalation?.enabled ?? true);
      setEscalateStart(next.dispatchEscalation?.startAt || '08:00');
      setEscalateEnd(next.dispatchEscalation?.endAt || '20:00');
      setMp({
        appId: next.wxServiceAccount?.appId ?? '',
        // 后端回的是 ••••••••1234 这种脱敏串：原样放进输入框，
        // 用户不动它就原样提交，后端认得出来「没改」（见 settings.service）
        appSecret: next.wxServiceAccount?.appSecret ?? '',
        templateOrderAssigned: next.wxServiceAccount?.templateOrderAssigned ?? '',
        enabled: !!next.wxServiceAccount?.enabled,
      });
      setAi({
        enabled: !!next.aiAssist?.enabled,
        baseUrl: next.aiAssist?.baseUrl ?? 'https://api.deepseek.com',
        model: next.aiAssist?.model ?? 'deepseek-v4-flash',
        // 同上：脱敏串原样放回输入框，不动它就是不改
        apiKey: next.aiAssist?.apiKey ?? '',
        timeoutMs: next.aiAssist?.timeoutMs ?? 6000,
      });
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
            orderOverdue: tplOverdue.trim(),
            orderUrge: tplUrge.trim(),
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

  const saveServiceAccount = async () => {
    setSavingMp(true);
    setMpResult(null);
    try {
      const next = await request<TenantSettings>({
        method: 'PATCH',
        url: '/settings',
        data: { wxServiceAccount: mp },
      });
      setSettings(next);
      setMp({
        appId: next.wxServiceAccount.appId,
        appSecret: next.wxServiceAccount.appSecret,
        templateOrderAssigned: next.wxServiceAccount.templateOrderAssigned,
        enabled: next.wxServiceAccount.enabled,
      });
      message.success('已保存');
    } catch (e: any) {
      message.error(e?.message || '保存失败');
    } finally {
      setSavingMp(false);
    }
  };

  /** 同步关注者 / 发送测试：结果里带的是微信的真话，原样显示，不要笼统成「失败」 */
  const runMpAction = async (
    kind: 'sync-followers' | 'test',
    setBusy: (v: boolean) => void,
  ) => {
    setBusy(true);
    setMpResult(null);
    try {
      const res = await request<{ ok: boolean; message: string }>({
        method: 'POST',
        url: `/notifications/service-account/${kind}`,
        data: {},
      });
      setMpResult({ ok: !!res.ok, message: res.message });
    } catch (e: any) {
      setMpResult({ ok: false, message: e?.message || '请求失败' });
    } finally {
      setBusy(false);
    }
  };

  /** 大模型：填完直接点「发送测试」，结果里带服务商的原话，不要笼统成「失败」 */
  const testAi = async () => {
    setTestingAi(true);
    setAiResult(null);
    try {
      const res = await request<{ ok: boolean; reply?: string; error?: string; model?: string }>({
        method: 'POST',
        url: '/settings/ai/test',
        data: ai,
      });
      setAiResult(
        res.ok
          ? { ok: true, message: `连通正常（${res.model}）：${res.reply || ''}` }
          : { ok: false, message: res.error || '调用失败' },
      );
    } catch (e: any) {
      setAiResult({ ok: false, message: e?.message || '请求失败' });
    } finally {
      setTestingAi(false);
    }
  };

  const saveAi = async () => {
    setSavingAi(true);
    try {
      const next = await request<TenantSettings>({
        method: 'PATCH',
        url: '/settings',
        data: { aiAssist: ai },
      });
      setSettings(next);
      setAi({
        enabled: !!next.aiAssist?.enabled,
        baseUrl: next.aiAssist?.baseUrl ?? '',
        model: next.aiAssist?.model ?? '',
        apiKey: next.aiAssist?.apiKey ?? '',
        timeoutMs: next.aiAssist?.timeoutMs ?? 6000,
      });
      message.success('已保存');
    } catch (e: any) {
      message.error(e?.message || '保存失败');
    } finally {
      setSavingAi(false);
    }
  };

  const saveEscalation = async () => {
    setSavingEscalate(true);
    try {
      const next = await request<TenantSettings>({
        method: 'PATCH',
        url: '/settings',
        data: {
          dispatchEscalation: {
            enabled: escalateEnabled,
            acceptMinutes: escalateMinutes,
            startAt: escalateStart,
            endAt: escalateEnd,
          },
        },
      });
      setSettings(next);
      setEscalateMinutes(next.dispatchEscalation.acceptMinutes);
      setEscalateEnabled(next.dispatchEscalation.enabled);
      setEscalateStart(next.dispatchEscalation.startAt);
      setEscalateEnd(next.dispatchEscalation.endAt);
      message.success(
        next.dispatchEscalation.enabled
          ? `已保存，${next.dispatchEscalation.startAt}~${next.dispatchEscalation.endAt} 之间才会催`
          : '已关闭催办提醒',
      );
    } catch (e: any) {
      message.error(e?.message || '保存失败');
    } finally {
      setSavingEscalate(false);
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

      <SettingSection
        title="微信订阅消息"
        summary="业主收「已派单 / 待验收」，维修工收「有新工单」，填模板 ID 才发得出去"
      >
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
              { key: 'orderOverdue' as TemplateKey, label: '超时没人接单，催办维修工', app: '员工端', value: tplOverdue, set: setTplOverdue },
              { key: 'orderUrge' as TemplateKey, label: '办公室催修（工单详情里手动发）', app: '员工端', value: tplUrge, set: setTplUrge },
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
      </SettingSection>

      <SettingSection
        title="工单自动验收"
        summary={`维修工报完工，业主 ${autoReviewHours} 小时不验收就由系统自动验收`}
      >
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
      </SettingSection>

      <SettingSection
        title="服务号通知维修工（推荐）"
        summary="关注了服务号就能一直推，不受小程序订阅「一次一条」的额度限制"
        extra={
          <Switch
            checked={mp.enabled}
            disabled={!canEdit}
            onChange={(checked) => setMp({ ...mp, enabled: checked })}
            checkedChildren="已开启"
            unCheckedChildren="已关闭"
          />
        }
      >
        <Paragraph style={{ marginBottom: 8 }}>
          小程序订阅消息是<Text strong>「同意一次只能推一条」</Text>，额度用完就哑火。
          服务号模板消息只要维修工<Text strong>关注着</Text>就能一直推，
          落在微信聊天列表的独立会话里，手机提醒和收到微信消息一样，
          点开还能<Text strong>直接跳到那张工单</Text>。
        </Paragraph>
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="开通前先确认这三件事"
          description={
            <ol style={{ margin: 0, paddingLeft: 18, lineHeight: 1.9 }}>
              <li>有一个<Text strong>已认证的服务号</Text>（企业主体，认证费 300 元/年）。未认证的订阅号发不了模板消息。</li>
              <li>
                服务号和员工端小程序绑到<Text strong>同一个微信开放平台账号</Text>下 ——
                只有这样才拿得到 UnionID，系统才能把「小程序里的这个维修工」和「服务号的这个粉丝」对上。
              </li>
              <li>维修工本人用<Text strong>同一个微信号</Text>关注服务号，并登录过员工端小程序。</li>
            </ol>
          }
        />
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <div>
            <Text strong>服务号 AppID</Text>
            <Input
              value={mp.appId}
              onChange={(e) => setMp({ ...mp, appId: e.target.value })}
              placeholder="wx 开头，在服务号后台「设置与开发 → 基本配置」里"
              disabled={!canEdit}
              allowClear
            />
          </div>
          <div>
            <Text strong>服务号 AppSecret</Text>
            <Input.Password
              value={mp.appSecret}
              onChange={(e) => setMp({ ...mp, appSecret: e.target.value })}
              placeholder="留空 = 保持原有密钥不变"
              disabled={!canEdit}
              autoComplete="new-password"
            />
            <Text type="secondary" style={{ fontSize: 13 }}>
              保存后只回显后 4 位。不动它就是不改；换了 AppID 会要求重新填。
            </Text>
          </div>
          <div>
            <Text strong>「新工单」模板 ID</Text>
            <Input
              value={mp.templateOrderAssigned}
              onChange={(e) => setMp({ ...mp, templateOrderAssigned: e.target.value })}
              placeholder="服务号后台「广告与服务 → 模板消息」里选一个，复制模板 ID"
              disabled={!canEdit}
              allowClear
            />
            <Text type="secondary" style={{ fontSize: 13 }}>
              选字段是 <Text code>first</Text> / <Text code>keyword1~4</Text> / <Text code>remark</Text>{' '}
              的通用模板即可，我们按「单号 / 类型 / 地址 / 时间」依次填。
            </Text>
          </div>

          {canEdit && (
            <Space wrap>
              <Button type="primary" loading={savingMp} onClick={saveServiceAccount}>
                保存
              </Button>
              <Button
                loading={syncingMp}
                onClick={() => runMpAction('sync-followers', setSyncingMp)}
              >
                同步关注者
              </Button>
              <Button loading={testingMp} onClick={() => runMpAction('test', setTestingMp)}>
                给我发一条测试
              </Button>
            </Space>
          )}

          {mpResult && (
            <Alert
              type={mpResult.ok ? 'success' : 'warning'}
              showIcon
              message={mpResult.message}
            />
          )}
        </Space>
        <Paragraph type="secondary" style={{ fontSize: 13, marginTop: 12, marginBottom: 0 }}>
          维修工新关注服务号之后，点一次<Text strong>「同步关注者」</Text>系统才知道他是谁。
          开着服务号时，派单通知优先走它；没关注的人自动退回小程序订阅消息，
          两条都不通时仍然会写进小程序里的「消息」。
        </Paragraph>
      </SettingSection>

      <SettingSection
        title="AI 维修填单助手（一句话报修 / 完工小结）"
        summary={
          ai.enabled
            ? `已开启：${ai.model}（${ai.baseUrl}）`
            : '未开启：只用内置的规则识别，行为和以前一样'
        }
        extra={
          <Space>
            <Text type="secondary">{ai.enabled ? '已开启' : '已关闭'}</Text>
            <Switch
              checked={ai.enabled}
              disabled={!canEdit}
              onChange={(v) => setAi({ ...ai, enabled: v })}
            />
          </Space>
        }
      >
        <Paragraph>
          报修人说一句「5511弄236号502电子门旋钮打滑，急急急，138…」，
          系统把<Text strong>地址、故障、联系人、电话、报修类型</Text>分开填好；维修工完工后
          说一句做了什么，系统再整理<Text strong>位置、现象、说明、用料草稿和收费建议</Text>。
          纯靠正则总有说不到的说法，开了这个之后由大模型来做<Text strong>语义</Text>那一半。
        </Paragraph>
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="门牌和电话仍然由系统自己定，不交给大模型"
          description={
            <span>
              大模型不知道你的房产库，它会编一个看着合理的房号，而地址错了就是师傅白跑一趟。
              所以模型给的地址只当<Text strong>线索</Text>，仍要回到房产库里撞一遍，撞不上就不采信；
              电话也仍按 11 位严格抽取。模型只负责「哪一段是地址、故障怎么说得通顺、有没有说人名」。
              <br />
              完工用料必须匹配真实材料 SKU，收费只能选后台已有规则；提交、扣库存和记费前都要人工确认。
              <br />
              调不通、超时、返回看不懂的内容时，<Text strong>自动退回原来的规则识别</Text>，
              不会因此让人提交不了报修。
            </span>
          }
        />
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <div>
            <Text strong>接口地址</Text>
            <Input
              value={ai.baseUrl}
              onChange={(e) => setAi({ ...ai, baseUrl: e.target.value })}
              placeholder="https://api.deepseek.com"
              disabled={!canEdit}
              allowClear
            />
            <Text type="secondary" style={{ fontSize: 13 }}>
              走 OpenAI 兼容协议（会自动拼上 <Text code>/v1/chat/completions</Text>）。
              DeepSeek、通义千问、智谱、Moonshot、本地 ollama 都能填，换一家只改这三栏。
            </Text>
          </div>
          <div>
            <Text strong>模型名</Text>
            <Input
              value={ai.model}
              onChange={(e) => setAi({ ...ai, model: e.target.value })}
              placeholder="deepseek-v4-flash"
              disabled={!canEdit}
              allowClear
            />
            {ai.baseUrl.includes('deepseek.com') && ai.model === 'deepseek-chat' ? (
              <Text type="warning" style={{ fontSize: 13 }}>
                当前仍是 DeepSeek 旧兼容模型名。建议改为 deepseek-v4-flash 后先点“发送测试”，通过再保存。
              </Text>
            ) : null}
          </div>
          <div>
            <Text strong>API Key</Text>
            <Input.Password
              value={ai.apiKey}
              onChange={(e) => setAi({ ...ai, apiKey: e.target.value })}
              placeholder="留空 = 保持原有密钥不变"
              disabled={!canEdit}
              autoComplete="new-password"
            />
            <Text type="secondary" style={{ fontSize: 13 }}>
              保存后只回显后 4 位。密钥只存在服务器，不会出现在日志和前端；换了接口地址会要求重填。
            </Text>
          </div>
          <div>
            <Text strong>超时</Text>
            <Space>
              <InputNumber
                min={1}
                max={30}
                value={Math.round(ai.timeoutMs / 1000)}
                onChange={(v) => setAi({ ...ai, timeoutMs: Math.round((v || 6) * 1000) })}
                disabled={!canEdit}
              />
              <Text type="secondary">秒，超过就退回规则识别</Text>
            </Space>
          </div>

          {canEdit && (
            <Space wrap>
              <Button type="primary" loading={savingAi} onClick={saveAi}>
                保存
              </Button>
              <Button loading={testingAi} onClick={testAi}>
                发送测试
              </Button>
            </Space>
          )}

          {aiResult && (
            <Alert
              type={aiResult.ok ? 'success' : 'warning'}
              showIcon
              message={aiResult.message}
            />
          )}
        </Space>
        <AiSamplesPanel canEdit={canEdit} />
        <AiLearningPanel canEdit={canEdit} />

        <Paragraph type="secondary" style={{ fontSize: 13, marginTop: 24, marginBottom: 0 }}>
          每次识别会调用一次模型，费用以服务商实时价格为准。报修原话可能包含住户姓名、电话和门牌，
          请使用符合公司数据合规要求的服务，并妥善保管 API Key。
        </Paragraph>
      </SettingSection>

      <SettingSection
        title="超时没人接单，自动催办"
        summary={
          escalateEnabled
            ? `超过 ${escalateMinutes} 分钟没人接，在 ${escalateStart}~${escalateEnd} 之间催一次`
            : '已关闭：没人接单时不会再提醒'
        }
        extra={
          <Space>
            <Text type="secondary">{escalateEnabled ? '已开启' : '已关闭'}</Text>
            <Switch
              checked={escalateEnabled}
              disabled={!canEdit}
              onChange={setEscalateEnabled}
            />
          </Space>
        }
      >
        <Paragraph>
          工单进了池子或派出去之后迟迟没人点「接单」，系统会<Text strong>再提醒该接的人一次</Text>
          （在池子里就提醒这个类型配的每一位维修工），同时通知<Text strong>所有能派单的人</Text>
          「这单还没人接」，工单进度里也会留一条记录。每张单只催一次，不会反复刷屏。
        </Paragraph>
        <Paragraph type="secondary" style={{ fontSize: 13 }}>
          为什么需要它：任何一条推送都可能被漏看（微信订阅额度用完、手机静音、人正在忙）。
          与其指望「通知一定送达」，不如让漏看一条不再是终点 —— 到点没接单，办公室能当场兜住。
        </Paragraph>
        <Space align="center" wrap size={12}>
          <Text strong>超过</Text>
          <InputNumber
            min={5}
            max={1440}
            precision={0}
            value={escalateMinutes}
            disabled={!canEdit || !escalateEnabled}
            onChange={(value) => setEscalateMinutes(value ?? 60)}
            addonAfter="分钟没人接就催"
            style={{ width: 230 }}
          />
          <Text strong>只在</Text>
          <Select
            value={escalateStart}
            disabled={!canEdit || !escalateEnabled}
            onChange={setEscalateStart}
            options={HOUR_OPTIONS}
            style={{ width: 110 }}
          />
          <Text>~</Text>
          <Select
            value={escalateEnd}
            disabled={!canEdit || !escalateEnabled}
            onChange={setEscalateEnd}
            options={HOUR_OPTIONS}
            style={{ width: 110 }}
          />
          <Text strong>之间催</Text>
          {canEdit && (
            <Button type="primary" loading={savingEscalate} onClick={saveEscalation}>
              保存
            </Button>
          )}
        </Space>
        <Paragraph type="secondary" style={{ fontSize: 13, marginTop: 12, marginBottom: 0 }}>
          建议 30～60 分钟：更短会把「人正在路上还没点接单」也算成漏看，更长就失去了当场兜住的意义。
          时段之外一条催办都不发（夜里把人震醒，第二天他会把提醒整个关掉）；
          时段外到点的单不会被漏掉，等第二天窗口一开照样催。起止选同一个点表示全天都催。
          催办用的是上面「超时没人接单，催办维修工」那个模板，没填就退回用新工单那个模板。
        </Paragraph>
      </SettingSection>

      <SettingSection
        title="业主手机号快速识别"
        summary="业主授权手机号后，按房产档案里的同号业主直接带出地址，不用扫码填房号"
      >
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
      </SettingSection>
    </div>
  );
}
