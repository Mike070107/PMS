import { useEffect, useState } from 'react';
import { Alert, Button, Modal, Space, Typography } from 'antd';
import { EnvironmentOutlined, ReloadOutlined } from '@ant-design/icons';
import type { MeterReadingRow } from '@pms/api-client';
import { readingMapUrl } from '../lib/meter-geo';

export default function ReadingLocationMap({ reading, onClose }: { reading: MeterReadingRow | null; onClose: () => void }) {
  const [loaded, setLoaded] = useState(false);
  const [slow, setSlow] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setLoaded(false); setSlow(false);
    if (!reading) return;
    const timer = setTimeout(() => setSlow(true), 12000);
    return () => clearTimeout(timer);
  }, [reading, attempt]);
  const src = reading?.latitude != null && reading.longitude != null ? readingMapUrl(reading.longitude, reading.latitude) : null;
  const external = reading && src ? `https://uri.amap.com/marker?position=${reading.longitude},${reading.latitude}&name=${encodeURIComponent(reading.meterNo + ' 抄表位置')}&coordinate=gaode&callnative=0` : undefined;
  return <Modal open={!!reading} title={<Space><EnvironmentOutlined />抄表现场定位</Space>} onCancel={onClose} footer={<Button onClick={onClose}>关闭</Button>} width={760} destroyOnClose>
    {reading && <>
      <Typography.Paragraph>{reading.meterNo} · {new Date(reading.readAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}</Typography.Paragraph>
      <Typography.Paragraph>定位精度：{reading.gpsAccuracy == null ? '未知' : `约 ${Math.round(Number(reading.gpsAccuracy))} 米`}。此处显示该次抄表保存的位置。</Typography.Paragraph>
      {!src ? <Alert type="warning" showIcon message="这条抄表没有有效的定位坐标" /> : <>
        {!loaded && <Typography.Paragraph role="status">{slow ? '地图加载较慢，可重试或在高德地图查看。' : '正在加载地图…'}</Typography.Paragraph>}
        <iframe key={attempt} src={src} title="抄表现场位置地图" referrerPolicy="no-referrer" onLoad={() => setLoaded(true)} onError={() => setSlow(true)} style={{ width: '100%', height: 'min(55vh, 420px)', minHeight: 260, border: '1px solid #c5d2dc', borderRadius: 8 }} />
        <Space wrap style={{ marginTop: 12 }}><Button icon={<ReloadOutlined />} onClick={() => setAttempt((value) => value + 1)}>重新加载地图</Button><Button href={external} target="_blank" rel="noopener noreferrer">在高德地图查看</Button></Space>
      </>}
    </>}
  </Modal>;
}
