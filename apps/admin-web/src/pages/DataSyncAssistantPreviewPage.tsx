import { useState } from 'react';
import {
  ApiOutlined,
  CheckCircleFilled,
  CloudServerOutlined,
  DatabaseOutlined,
  DesktopOutlined,
  HistoryOutlined,
  PlusOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  UsbOutlined,
  WifiOutlined,
} from '@ant-design/icons';
import './DataSyncAssistantPreviewPage.css';

type ConnectionKind = 'parking' | 'legacy' | 'reader' | 'access';

const connectionTypes: Array<{
  key: ConnectionKind;
  icon: React.ReactNode;
  title: string;
  desc: string;
}> = [
  { key: 'parking', icon: <DatabaseOutlined />, title: '停车系统', desc: '连接 SQL Server 停车数据库' },
  { key: 'legacy', icon: <HistoryOutlined />, title: '旧发卡数据库', desc: '查询住户和历史发卡记录' },
  { key: 'access', icon: <CloudServerOutlined />, title: '门禁系统', desc: '连接 MjSystem / iCCard 数据' },
  { key: 'reader', icon: <UsbOutlined />, title: 'USB 发卡器', desc: '自动发现本机 PC/SC 读卡器' },
];

function ConnectionCard({
  icon,
  title,
  subtitle,
  details,
  state,
  tone = 'ok',
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  details: string[];
  state: string;
  tone?: 'ok' | 'warn';
}) {
  return (
    <article className="dsa-connection-card">
      <div className={`dsa-connection-icon ${tone}`}>{icon}</div>
      <div className="dsa-connection-main">
        <div className="dsa-connection-title-row">
          <div>
            <h3>{title}</h3>
            <p>{subtitle}</p>
          </div>
          <span className={`dsa-status-pill ${tone}`}>
            {tone === 'ok' && <CheckCircleFilled />}{state}
          </span>
        </div>
        <div className="dsa-detail-row">
          {details.map((detail) => <span key={detail}>{detail}</span>)}
        </div>
      </div>
      <button className="dsa-icon-button" aria-label={`设置${title}`}><SettingOutlined /></button>
    </article>
  );
}

export default function DataSyncAssistantPreviewPage() {
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<ConnectionKind>('parking');
  const [step, setStep] = useState(1);

  const closeWizard = () => {
    setAdding(false);
    setStep(1);
  };

  return (
    <div className="dsa-preview-stage">
      <div className="dsa-window">
        <header className="dsa-titlebar">
          <div className="dsa-brand-mark"><ApiOutlined /></div>
          <div className="dsa-title-copy">
            <strong>PMS 数据同步助手</strong>
            <span>物业办公室-01</span>
          </div>
          <div className="dsa-title-status"><span className="dsa-live-dot" />PMS 已连接</div>
          <button className="dsa-title-action"><ReloadOutlined /> 检查更新</button>
          <div className="dsa-window-controls"><span>—</span><span>□</span><span>×</span></div>
        </header>

        <main className="dsa-content">
          <section className="dsa-hero">
            <div>
              <span className="dsa-eyebrow">本机服务概览</span>
              <h1>所有数据连接都正常</h1>
              <p>助手在后台持续运行，关闭此窗口不会停止数据同步。</p>
            </div>
            <div className="dsa-health-summary">
              <div><WifiOutlined /><span><strong>已连接</strong><small>PMS 服务</small></span></div>
              <div><SafetyCertificateOutlined /><span><strong>已加密</strong><small>本机凭据</small></span></div>
              <div><DesktopOutlined /><span><strong>运行中</strong><small>后台服务</small></span></div>
            </div>
          </section>

          <section className="dsa-section">
            <div className="dsa-section-heading">
              <div><h2>数据连接</h2><span>4 个连接 · 3 个正常 · 1 个待验收</span></div>
              <button className="dsa-primary" onClick={() => setAdding(true)}><PlusOutlined />添加连接</button>
            </div>
            <div className="dsa-connections">
              <ConnectionCard
                icon={<DatabaseOutlined />}
                title="枫桦景苑停车系统"
                subtitle="SQL Server · 192.168.6.3"
                details={['一期数据库 已连接', '二期数据库 已连接', '最近查询 10:42']}
                state="查询正常"
              />
              <ConnectionCard
                icon={<HistoryOutlined />}
                title=".80 旧库同步"
                subtitle="SQL Server · 本机服务"
                details={['住户资料 可读取', '发卡历史 可读取', '最近同步 10:39']}
                state="运行正常"
              />
              <ConnectionCard
                icon={<UsbOutlined />}
                title="办公室发卡器"
                subtitle="ACS ACR122U PICC Interface"
                details={['设备已识别', '工作站可接任务', '当前无待处理卡片']}
                state="设备在线"
              />
              <ConnectionCard
                icon={<CloudServerOutlined />}
                title="门禁数据库"
                subtitle="MjSystem / iCCard"
                details={['数据库 可读取', '控制器 8 台', '写入尚未开放']}
                state="待写入验收"
                tone="warn"
              />
            </div>
          </section>

          <section className="dsa-bottom-grid">
            <div className="dsa-activity-card">
              <div className="dsa-card-heading"><h2>最近活动</h2><button>查看全部</button></div>
              <ol>
                <li><span className="dsa-event-dot ok" /><div><strong>停车系统查询成功</strong><small>车牌 沪BDQ8839 · 10:42:18</small></div></li>
                <li><span className="dsa-event-dot ok" /><div><strong>PMS 心跳正常</strong><small>4 个连接已上报 · 10:42:05</small></div></li>
                <li><span className="dsa-event-dot neutral" /><div><strong>发卡器等待任务</strong><small>办公室发卡器 · 10:41:52</small></div></li>
              </ol>
            </div>
            <div className="dsa-info-card">
              <div className="dsa-card-heading"><h2>助手信息</h2><button>诊断</button></div>
              <dl>
                <div><dt>电脑名称</dt><dd>物业办公室-01</dd></div>
                <div><dt>当前版本</dt><dd>2.0.0 设计预览</dd></div>
                <div><dt>配置保存</dt><dd><CheckCircleFilled /> 已自动保存</dd></div>
                <div><dt>下次检查更新</dt><dd>今天 18:00</dd></div>
              </dl>
            </div>
          </section>
        </main>
      </div>

      {adding && (
        <div className="dsa-modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && closeWizard()}>
          <section className="dsa-wizard" role="dialog" aria-modal="true" aria-label="添加数据连接">
            <header>
              <div><span className="dsa-eyebrow">添加数据连接</span><h2>{step === 1 ? '要连接什么？' : step === 2 ? '确认检测结果' : '测试并保存'}</h2></div>
              <button onClick={closeWizard} aria-label="关闭">×</button>
            </header>
            <div className="dsa-steps">
              {[1, 2, 3].map((item) => <span key={item} className={item <= step ? 'active' : ''}><b>{item}</b>{item === 1 ? '选择类型' : item === 2 ? '检查参数' : '完成'}</span>)}
            </div>

            {step === 1 && (
              <div className="dsa-type-grid">
                {connectionTypes.map((item) => (
                  <button key={item.key} className={selected === item.key ? 'selected' : ''} onClick={() => setSelected(item.key)}>
                    <span>{item.icon}</span><strong>{item.title}</strong><small>{item.desc}</small>
                  </button>
                ))}
              </div>
            )}
            {step === 2 && (
              <div className="dsa-detection">
                <div className="dsa-detect-banner"><CheckCircleFilled /><div><strong>已自动发现停车数据库</strong><span>以下参数来自本机检测，只需要确认。</span></div></div>
                <label>连接名称<input value="枫桦景苑停车系统" readOnly /></label>
                <div className="dsa-form-row"><label>SQL Server<input value="192.168.6.3" readOnly /></label><label>数据库用户<input value="sa" readOnly /></label></div>
                <label>数据库密码<div className="dsa-saved-secret"><SafetyCertificateOutlined />已安全保存，无需重新输入<button>更换</button></div></label>
                <div className="dsa-database-tags"><span><CheckCircleFilled /> parking1</span><span><CheckCircleFilled /> parking2</span></div>
              </div>
            )}
            {step === 3 && (
              <div className="dsa-test-result">
                <div className="dsa-success-ring"><CheckCircleFilled /></div>
                <h3>连接测试通过</h3>
                <p>参数已自动保存，后台服务会立即开始同步。</p>
                <ul><li><CheckCircleFilled /> SQL Server 可以访问</li><li><CheckCircleFilled /> parking1 / parking2 可以读取</li><li><CheckCircleFilled /> 凭据已在本机加密保存</li></ul>
              </div>
            )}

            <footer>
              <button className="dsa-secondary" onClick={step === 1 ? closeWizard : () => setStep(step - 1)}>{step === 1 ? '取消' : '上一步'}</button>
              <button className="dsa-primary" onClick={step === 3 ? closeWizard : () => setStep(step + 1)}>{step === 1 ? '继续' : step === 2 ? '测试连接' : '完成'}</button>
            </footer>
          </section>
        </div>
      )}
    </div>
  );
}
