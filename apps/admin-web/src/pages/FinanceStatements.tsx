import {
  CheckCircleOutlined, CloseCircleOutlined, DownloadOutlined, FileDoneOutlined, FundOutlined,
  SafetyCertificateOutlined, WarningOutlined,
} from '@ant-design/icons';
import { Alert, Button, Card, Empty, Statistic, Table, Tabs, Tag } from 'antd';
import type { TableColumnsType } from 'antd';

export type StatementRow = {
  line: number | null;
  label: string;
  kind: 'section' | 'item' | 'detail' | 'subtotal' | 'total';
  opening?: number;
  closing?: number;
  current?: number;
  ytd?: number;
};

export type FinanceReports = {
  period: string;
  entityName: string;
  accountingStandard: string;
  unit: string;
  balanceSheet: {
    formCode: string;
    assetRows: StatementRow[];
    liabilityEquityRows: StatementRow[];
    assets: number;
    liabilities: number;
    equity: number;
    liabilitiesAndEquity: number;
    openingBalanced: boolean;
    balanced: boolean;
  };
  profitStatement: {
    formCode: string;
    rows: StatementRow[];
    operatingRevenue: number;
    operatingCosts: number;
    netProfit: number;
  };
  cashFlowStatement: {
    formCode: string;
    rows: StatementRow[];
    cashIncrease: number;
    endingCash: number;
    classification: { explicit: number; inferred: number; pending: number; pendingAmount: number; coverage: number };
  };
  validations: Array<{ key: string; label: string; ok: boolean; warning?: boolean; detail: string }>;
  traceable: boolean;
  cashFlowReconciled: boolean;
};

type BalanceDisplayRow = { key: number; asset?: StatementRow; liability?: StatementRow };

const money = (value: unknown) => Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const amount = (value: unknown) => value === undefined || value === null || value === '' ? null : <span className="statement-amount">{money(value)}</span>;

function rowClassName(row: StatementRow) {
  return `statement-row statement-row--${row.kind}`;
}

function StandardStatementHeader({ title, code, reports }: { title: string; code: string; reports: FinanceReports }) {
  return <div className="statement-sheet-heading">
    <div><span>{code}</span><h3>{title}</h3></div>
    <dl><div><dt>编制单位</dt><dd>{reports.entityName}</dd></div><div><dt>报表期间</dt><dd>{reports.period}</dd></div><div><dt>金额单位</dt><dd>{reports.unit}</dd></div></dl>
  </div>;
}

export default function FinanceStatements({ reports, loading, onDownload }: { reports: FinanceReports | null; loading: boolean; onDownload: () => void }) {
  if (!reports) return <Card loading={loading} className="accounting-card"><Empty description="当前期间还没有可生成的财务报表" /></Card>;
  const balanceRows: BalanceDisplayRow[] = Array.from({ length: Math.max(reports.balanceSheet.assetRows.length, reports.balanceSheet.liabilityEquityRows.length) }, (_, index) => ({
    key: index, asset: reports.balanceSheet.assetRows[index], liability: reports.balanceSheet.liabilityEquityRows[index],
  }));
  const balanceColumns: TableColumnsType<BalanceDisplayRow> = [
    { title: '资产', dataIndex: ['asset','label'], width: 230, render: (value: string, row) => <span className={row.asset?.kind === 'detail' ? 'statement-indent' : ''}>{value}</span> },
    { title: '行次', dataIndex: ['asset','line'], width: 64, align: 'center' as const },
    { title: '期末余额', dataIndex: ['asset','closing'], width: 140, align: 'right' as const, render: amount },
    { title: '年初余额', dataIndex: ['asset','opening'], width: 140, align: 'right' as const, render: amount },
    { title: '负债和所有者权益', dataIndex: ['liability','label'], width: 280, render: (value: string, row) => <span className={row.liability?.kind === 'detail' ? 'statement-indent' : ''}>{value}</span> },
    { title: '行次', dataIndex: ['liability','line'], width: 64, align: 'center' as const },
    { title: '期末余额', dataIndex: ['liability','closing'], width: 140, align: 'right' as const, render: amount },
    { title: '年初余额', dataIndex: ['liability','opening'], width: 140, align: 'right' as const, render: amount },
  ];
  const verticalColumns = [
    { title: '项目', dataIndex: 'label', minWidth: 400, render: (value: string, row: StatementRow) => <span className={row.kind === 'detail' ? 'statement-indent' : ''}>{value}</span> },
    { title: '行次', dataIndex: 'line', width: 74, align: 'center' as const },
    { title: '本年累计金额', dataIndex: 'ytd', width: 170, align: 'right' as const, render: amount },
    { title: '本月金额', dataIndex: 'current', width: 170, align: 'right' as const, render: amount },
  ];
  const failing = reports?.validations.filter((item) => !item.ok && !item.warning).length || 0;
  const warnings = reports?.validations.filter((item) => !item.ok && item.warning).length || 0;
  return <div className="statement-workspace">
    <div className="statement-command-bar">
      <div><span className="statement-kicker"><FileDoneOutlined /> 上海财务报表报送口径</span><h3>标准财务报表</h3><p>完整表式、正式行次、年初与本期金额、勾稽关系和科目追溯一次生成。</p></div>
      <Button type="primary" size="large" icon={<DownloadOutlined />} onClick={onDownload}>导出完整 Excel</Button>
    </div>
    <div className="statement-metrics">
      <Card><Statistic title="资产总计" value={reports?.balanceSheet.assets || 0} precision={2} prefix="¥" /></Card>
      <Card><Statistic title="负债和所有者权益" value={reports?.balanceSheet.liabilitiesAndEquity || 0} precision={2} prefix="¥" /></Card>
      <Card><Statistic title="本年累计净利润" value={reports?.profitStatement.netProfit || 0} precision={2} prefix="¥" valueStyle={{ color: Number(reports?.profitStatement.netProfit || 0) < 0 ? '#b74c3f' : '#176f59' }} /></Card>
      <Card><Statistic title="期末现金余额" value={reports?.cashFlowStatement.endingCash || 0} precision={2} prefix="¥" /></Card>
    </div>
    <div className="statement-health">
      <div className={failing ? 'is-error' : 'is-ok'}>{failing ? <CloseCircleOutlined /> : <SafetyCertificateOutlined />}<span>报表硬性校验</span><strong>{failing ? `${failing} 项未通过` : '全部通过'}</strong></div>
      <div className={warnings ? 'is-warning' : 'is-ok'}>{warnings ? <WarningOutlined /> : <CheckCircleOutlined />}<span>待人工确认</span><strong>{warnings ? `${warnings} 项` : '无需处理'}</strong></div>
      <div className={Number(reports?.cashFlowStatement.classification.coverage || 0) < 100 ? 'is-warning' : 'is-ok'}><FundOutlined /><span>现金流分类覆盖率</span><strong>{money(reports?.cashFlowStatement.classification.coverage)}%</strong></div>
    </div>
    <Tabs className="statement-tabs" items={[
      { key: 'balance', label: '资产负债表', children: <Card className="statement-sheet" loading={loading}><StandardStatementHeader title="资产负债表（小企业会计准则）" code={reports?.balanceSheet.formCode || '会小企 01 表'} reports={reports!} /><Table rowKey="key" dataSource={balanceRows} columns={balanceColumns} pagination={false} bordered size="small" scroll={{ x: 1390 }} rowClassName={(row) => row.asset?.kind === 'total' || row.liability?.kind === 'total' ? 'statement-row statement-row--total' : row.asset?.kind === 'subtotal' || row.liability?.kind === 'subtotal' ? 'statement-row statement-row--subtotal' : row.asset?.kind === 'section' || row.liability?.kind === 'section' ? 'statement-row statement-row--section' : 'statement-row'} /></Card> },
      { key: 'profit', label: '利润表', children: <Card className="statement-sheet" loading={loading}><StandardStatementHeader title="利润表（小企业会计准则）" code={reports?.profitStatement.formCode || '会小企 02 表'} reports={reports!} /><Table rowKey={(row) => String(row.line)} dataSource={reports?.profitStatement.rows || []} columns={verticalColumns} pagination={false} bordered size="small" scroll={{ x: 820 }} rowClassName={rowClassName} /></Card> },
      { key: 'cash', label: <span>现金流量表 {warnings > 0 && <Tag color="gold">待确认</Tag>}</span>, children: <><Card className="statement-sheet" loading={loading}><StandardStatementHeader title="现金流量表（小企业会计准则）" code={reports?.cashFlowStatement.formCode || '会小企 03 表'} reports={reports!} /><Table rowKey={(row) => `${row.line}-${row.label}`} dataSource={reports?.cashFlowStatement.rows || []} columns={verticalColumns} pagination={false} bordered size="small" scroll={{ x: 820 }} rowClassName={rowClassName} /></Card>{Number(reports?.cashFlowStatement.classification.pending || 0) > 0 && <Alert className="statement-classification-alert" showIcon type="warning" message={`${reports?.cashFlowStatement.classification.pending} 笔现金收支需要确认分类`} description={`系统暂时归入“其他经营活动”，涉及 ${money(reports?.cashFlowStatement.classification.pendingAmount)} 元。后续可在凭证中选择现金流项目，报表会自动重算。`} />}</> },
      { key: 'checks', label: '报表校验', children: <Card className="statement-check-card" title="报表勾稽与报送检查"><div className="statement-check-list">{reports?.validations.map((item) => <div key={item.key} className={item.ok ? 'is-ok' : item.warning ? 'is-warning' : 'is-error'}>{item.ok ? <CheckCircleOutlined /> : item.warning ? <WarningOutlined /> : <CloseCircleOutlined />}<div><strong>{item.label}</strong><p>{item.detail}</p></div><Tag color={item.ok ? 'green' : item.warning ? 'gold' : 'red'}>{item.ok ? '通过' : item.warning ? '需确认' : '不通过'}</Tag></div>)}</div></Card> },
    ]} />
    <Alert className="statement-source-note" showIcon type="info" message="按上海小企业会计准则报表口径生成" description="资产负债表、利润表和现金流量表采用财政部会小企 01、02、03 表结构。实际报送频次及表种仍以企业在上海电子税务局登记的财务会计制度备案为准。" />
  </div>;
}
