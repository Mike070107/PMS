import { Alert, Button, Input, Modal, Progress, Space, Table, Tag, Typography, App as AntdApp } from 'antd';
import { useState } from 'react';
import { request, ApiError } from '../lib/api';

const { Text, Paragraph } = Typography;

interface ParsedRow {
  community: string;
  lane: string;       // 可能为空字符串
  buildingNo: string;
  roomNo: string;
}

interface ParseResult {
  rows: ParsedRow[];
  skippedLines: number;
  detectedColumns: number;
}

interface Community { id: number; name: string }
interface Building  { id: number; lane?: string; buildingNo: string }
interface House     { id: number; roomNo: string }

export default function PropertiesImportModal({
  open, onClose, onDone,
}: { open: boolean; onClose: () => void; onDone: () => void }) {
  const { message } = AntdApp.useApp();
  const [text, setText] = useState('');
  const [parsed, setParsed] = useState<ParseResult | null>(null);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressTotal, setProgressTotal] = useState(0);
  const [progressLabel, setProgressLabel] = useState('');
  const [result, setResult] = useState<{ created: number; skipped: number; errors: string[] } | null>(null);

  const reset = () => {
    setText(''); setParsed(null); setImporting(false);
    setProgress(0); setProgressTotal(0); setProgressLabel('');
    setResult(null);
  };

  const close = () => { reset(); onClose(); };

  const onParse = () => {
    const p = parseText(text);
    if (p.rows.length === 0) {
      return message.warning('没解析到有效行，检查粘贴内容');
    }
    setParsed(p);
  };

  const onImport = async () => {
    if (!parsed) return;
    setImporting(true);
    const errors: string[] = [];
    let created = 0, skipped = 0;

    try {
      // ---- 1. 拉现有小区 ----
      setProgressLabel('加载已有小区...');
      setProgressTotal(1); setProgress(0);
      const allCommunities = await request<Community[]>({ url: '/communities' });
      const commByName = new Map(allCommunities.map((c) => [c.name, c]));

      // ---- 2. 待建小区 ----
      const neededCommunityNames = unique(parsed.rows.map((r) => r.community));
      for (let i = 0; i < neededCommunityNames.length; i++) {
        const name = neededCommunityNames[i];
        setProgressLabel(`小区 ${i + 1}/${neededCommunityNames.length}：${name}`);
        setProgressTotal(neededCommunityNames.length); setProgress(i + 1);
        if (!commByName.has(name)) {
          try {
            const c = await request<Community>({ method: 'POST', url: '/communities', data: { name } });
            commByName.set(name, c);
            created++;
          } catch (e: any) {
            errors.push(`小区「${name}」创建失败：${e.message}`);
          }
        } else {
          skipped++;
        }
      }

      // ---- 3. 楼栋 ----
      // key = communityName -> buildings array
      const buildingsCache = new Map<string, Map<string, Building>>(); // commName -> (lane|no -> Building)
      const neededBuildings = unique(parsed.rows.map((r) => `${r.community}|${r.lane}|${r.buildingNo}`));
      setProgressTotal(neededBuildings.length); setProgress(0);

      for (let i = 0; i < neededBuildings.length; i++) {
        const [commName, lane, buildingNo] = neededBuildings[i].split('|');
        const comm = commByName.get(commName);
        if (!comm) { errors.push(`楼栋「${commName} ${lane}弄${buildingNo}号」找不到小区`); continue; }

        setProgressLabel(`楼栋 ${i + 1}/${neededBuildings.length}：${commName} ${lane ? lane + '弄' : ''}${buildingNo}号`);
        setProgress(i + 1);

        if (!buildingsCache.has(commName)) {
          const bs = await request<Building[]>({ url: '/buildings', query: { communityId: comm.id } });
          const map = new Map<string, Building>();
          bs.forEach((b) => map.set(`${b.lane || ''}|${b.buildingNo}`, b));
          buildingsCache.set(commName, map);
        }
        const bMap = buildingsCache.get(commName)!;
        const bk = `${lane}|${buildingNo}`;
        if (!bMap.has(bk)) {
          try {
            const data: any = { communityId: comm.id, buildingNo };
            if (lane) data.lane = lane;
            const b = await request<Building>({ method: 'POST', url: '/buildings', data });
            bMap.set(bk, b);
            created++;
          } catch (e: any) {
            errors.push(`楼栋「${commName} ${lane}弄${buildingNo}号」创建失败：${e.message}`);
          }
        } else {
          skipped++;
        }
      }

      // ---- 4. 房号 ----
      const housesCache = new Map<number, Map<string, House>>(); // buildingId -> roomNo -> House
      setProgressTotal(parsed.rows.length); setProgress(0);

      for (let i = 0; i < parsed.rows.length; i++) {
        const r = parsed.rows[i];
        setProgressLabel(`房号 ${i + 1}/${parsed.rows.length}：${r.community} ${r.lane}弄${r.buildingNo}号${r.roomNo}室`);
        setProgress(i + 1);

        const comm = commByName.get(r.community);
        const bMap = comm ? buildingsCache.get(r.community) : undefined;
        const b = bMap?.get(`${r.lane}|${r.buildingNo}`);
        if (!comm || !b) { errors.push(`房号「${r.community} ${r.lane}弄${r.buildingNo}号${r.roomNo}室」找不到上级`); continue; }

        if (!housesCache.has(b.id)) {
          const hs = await request<House[]>({ url: '/houses', query: { buildingId: b.id } });
          const map = new Map<string, House>();
          hs.forEach((h) => map.set(h.roomNo, h));
          housesCache.set(b.id, map);
        }
        const hMap = housesCache.get(b.id)!;
        if (!hMap.has(r.roomNo)) {
          try {
            const h = await request<House>({ method: 'POST', url: '/houses', data: { buildingId: b.id, roomNo: r.roomNo } });
            hMap.set(r.roomNo, h);
            created++;
          } catch (e: any) {
            errors.push(`房号「${r.community} ${r.lane}弄${r.buildingNo}号${r.roomNo}室」创建失败：${e instanceof ApiError ? e.message : e.message}`);
          }
        } else {
          skipped++;
        }
      }

      setResult({ created, skipped, errors });
      message.success(`导入完成：新建 ${created}，跳过 ${skipped}${errors.length ? `，失败 ${errors.length}` : ''}`);
      onDone();
    } catch (e: any) {
      message.error(e?.message || '导入过程出错');
    } finally {
      setImporting(false);
    }
  };

  return (
    <Modal
      open={open}
      onCancel={close}
      title="导入房产资料"
      width={780}
      footer={
        result ? <Button type="primary" onClick={close}>关闭</Button> :
        !parsed ? (
          <Space>
            <Button onClick={close}>取消</Button>
            <Button type="primary" onClick={onParse} disabled={!text.trim()}>解析</Button>
          </Space>
        ) : (
          <Space>
            <Button onClick={() => setParsed(null)} disabled={importing}>返回修改</Button>
            <Button type="primary" loading={importing} onClick={onImport}>确认导入 {parsed.rows.length} 条</Button>
          </Space>
        )
      }
      destroyOnHidden
    >
      {!parsed && !result && (
        <>
          <Alert
            type="info" showIcon style={{ marginBottom: 12 }}
            message="从 Excel 中选中表格区域，按 Ctrl+C，再到下面 Ctrl+V 粘贴"
            description="支持 4 列（小区/弄/号/室）或 5 列（物业/小区/弄/号/室）。第一行如果是表头会自动识别跳过。"
          />
          <Input.TextArea
            rows={12}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'吴泾物业\t枫桦景苑\t198\t1\t101\n吴泾物业\t枫桦景苑\t198\t1\t102\n...'}
            style={{ fontFamily: 'monospace', fontSize: 12 }}
          />
        </>
      )}

      {parsed && !importing && !result && (
        <>
          <Alert
            type="success" showIcon style={{ marginBottom: 12 }}
            message={`已解析 ${parsed.rows.length} 行（识别为 ${parsed.detectedColumns} 列）`}
            description={parsed.skippedLines > 0 ? `跳过 ${parsed.skippedLines} 个无效行（含表头/空行）` : undefined}
          />
          <PreviewTable rows={parsed.rows} />
        </>
      )}

      {importing && (
        <div style={{ padding: '20px 0' }}>
          <Paragraph>{progressLabel}</Paragraph>
          <Progress percent={Math.round((progress / Math.max(progressTotal, 1)) * 100)} />
        </div>
      )}

      {result && (
        <div>
          <Alert
            type={result.errors.length ? 'warning' : 'success'} showIcon style={{ marginBottom: 12 }}
            message={`新建 ${result.created} 条，跳过 ${result.skipped} 条已存在`}
            description={result.errors.length ? `${result.errors.length} 条失败，详见下方` : undefined}
          />
          {result.errors.length > 0 && (
            <div style={{ maxHeight: 240, overflow: 'auto', background: '#fafafa', padding: 12, borderRadius: 4 }}>
              {result.errors.map((e, i) => <div key={i} style={{ fontSize: 12, color: '#cf1322' }}>{e}</div>)}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

// ---------- 辅助 ----------

function unique(arr: string[]): string[] {
  return Array.from(new Set(arr));
}

function parseText(text: string): ParseResult {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return { rows: [], skippedLines: 0, detectedColumns: 0 };

  // 检测分隔符：制表符优先，其次连续空格，最后逗号
  const detectCols = (line: string): string[] => {
    if (line.includes('\t')) return line.split('\t').map((c) => c.trim());
    if (/\s{2,}/.test(line))  return line.split(/\s{2,}/).map((c) => c.trim());
    if (line.includes(','))   return line.split(',').map((c) => c.trim());
    return line.split(/\s+/).map((c) => c.trim());
  };

  // 识别表头
  let startIdx = 0;
  const headerKeywords = ['物业', '小区', '弄', '号', '室', '房号', '楼栋'];
  const firstCols = detectCols(lines[0]);
  if (firstCols.some((c) => headerKeywords.includes(c))) startIdx = 1;

  // 由第一行数据决定列数
  const sampleCols = detectCols(lines[startIdx] || '').length;
  const detectedColumns = sampleCols;

  const rows: ParsedRow[] = [];
  let skipped = 0;
  for (let i = startIdx; i < lines.length; i++) {
    const cols = detectCols(lines[i]);
    let community = '', lane = '', buildingNo = '', roomNo = '';
    if (cols.length === 5) {
      [, community, lane, buildingNo, roomNo] = cols;
    } else if (cols.length === 4) {
      [community, lane, buildingNo, roomNo] = cols;
    } else {
      skipped++; continue;
    }
    if (!community || !buildingNo || !roomNo) { skipped++; continue; }
    rows.push({ community, lane, buildingNo, roomNo });
  }

  // 行级去重
  const seen = new Set<string>();
  const dedup: ParsedRow[] = [];
  for (const r of rows) {
    const k = `${r.community}|${r.lane}|${r.buildingNo}|${r.roomNo}`;
    if (seen.has(k)) { skipped++; continue; }
    seen.add(k); dedup.push(r);
  }

  return { rows: dedup, skippedLines: skipped, detectedColumns };
}

function PreviewTable({ rows }: { rows: ParsedRow[] }) {
  const commCount = unique(rows.map((r) => r.community)).length;
  const bldgCount = unique(rows.map((r) => `${r.community}|${r.lane}|${r.buildingNo}`)).length;

  return (
    <>
      <Space style={{ marginBottom: 8 }}>
        <Tag color="blue">{commCount} 个小区</Tag>
        <Tag color="cyan">{bldgCount} 个楼栋</Tag>
        <Tag color="green">{rows.length} 个房号</Tag>
        <Text type="secondary">已存在的将自动跳过</Text>
      </Space>
      <Table
        size="small"
        rowKey={(r, i) => String(i)}
        dataSource={rows}
        pagination={{ pageSize: 8 }}
        columns={[
          { title: '小区', dataIndex: 'community' },
          { title: '弄', dataIndex: 'lane', width: 80 },
          { title: '号', dataIndex: 'buildingNo', width: 80 },
          { title: '室', dataIndex: 'roomNo', width: 80 },
        ]}
      />
    </>
  );
}
