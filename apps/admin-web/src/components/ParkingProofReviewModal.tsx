import { useEffect, useState } from 'react';
import { Alert, Button, Empty, Image, Input, Modal, Space, Typography } from 'antd';
import { accessCardIssuance } from '@pms/api-client';

export default function ParkingProofReviewModal({ proof, onClose, onChanged, canReview }: {
  proof: accessCardIssuance.ParkingProofUpload | null; onClose: () => void; onChanged: () => void; canReview: boolean;
}) {
  const [reason, setReason] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [previewOpen, setPreviewOpen] = useState(false);
  const [reviewStatus, setReviewStatus] = useState(proof?.reviewStatus);
  useEffect(() => { setReviewStatus(proof?.reviewStatus); setPreviewOpen(false); }, [proof?.id, proof?.reviewStatus]);
  useEffect(() => {
    if (!previewOpen) return;
    const closeOutside = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.matches('.ant-image-preview-img-wrapper, .ant-image-preview-body, .ant-image-preview-content, .ant-image-preview-wrap, .ant-image-preview-mask')) setPreviewOpen(false);
    };
    document.addEventListener('click', closeOutside);
    return () => document.removeEventListener('click', closeOutside);
  }, [previewOpen]);
  useEffect(() => { setReason(''); setRejecting(false); setError(''); setSuccess(''); }, [proof?.id]);
  const review = async (decision: 'approved' | 'rejected') => {
    if (!proof || busy) return;
    if (decision === 'rejected' && !reason.trim()) { setError('请填写驳回原因'); return; }
    setBusy(true); setError(''); setSuccess('');
    try {
      const response = await accessCardIssuance.reviewParkingProof(proof.id, decision, reason);
      setReviewStatus(decision);
      setRejecting(false);
      onChanged();
      if (decision === 'rejected') { setSuccess('已驳回，车库保持未授权'); return; }
      let task = response.operation;
      for (let attempt = 0; task && ['pending', 'running'].includes(task.status) && attempt < 112; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 800));
        task = await accessCardIssuance.parkingOperation(task.id);
      }
      if (task && task.status !== 'completed') throw new Error(`资料已通过，但车库授权${task.status === 'failed' ? '失败' : '结果待确认'}：${task.error || '请再次点击审核通过以查询原任务，不要重新登记'}`);
      if (response.cloudOperation && response.cloudOperation.status !== 'completed') throw new Error(`资料已通过，但人防授权失败：${response.cloudOperation.error}`);
      setSuccess('审核已通过，对应车库授权已读回验证；设备下载状态请在授权清单中核对。'); onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '审核未完成'); onChanged(); }
    finally { setBusy(false); }
  };
  const files = proof?.files?.length ? proof.files : proof?.fileUrl ? [{ fileUrl: proof.fileUrl, fileName: proof.fileName || '证明材料', contentType: 'image/unknown' }] : [];
  return <Modal title={`亲情车资料审核 · ${proof?.plate || ''}`} open={!!proof} onCancel={onClose} width={760} maskClosable={!busy} closable={!busy}
    footer={canReview ? <Space wrap><Button onClick={onClose} disabled={busy}>关闭</Button><Button danger disabled={busy || reviewStatus === 'approved'} onClick={() => { if (rejecting) void review('rejected'); else setRejecting(true); }}>驳回</Button><Button type="primary" loading={busy} disabled={!files.length} onClick={() => void review('approved')}>{reviewStatus === 'approved' && error ? '重试车库授权' : '审核通过'}</Button></Space> : <Button onClick={onClose}>关闭</Button>}>
    <Typography.Paragraph>审核状态：{reviewStatus === 'approved' ? '已通过' : reviewStatus === 'rejected' ? '驳回' : '待审核'}{proof?.reviewReason && ` · ${proof.reviewReason}`}</Typography.Paragraph>
    {error && <Alert type="error" showIcon message="操作未完成" description={error} />}
    {success && <Alert type="success" showIcon message={success} />}
    <Image.PreviewGroup preview={{ maskClosable: true, visible: previewOpen, onVisibleChange: setPreviewOpen }}><div className="parking-proof-thumbnails">{files.map((file) => file.contentType === 'application/pdf'
      ? <a key={file.fileUrl} href={file.fileUrl} target="_blank" rel="noreferrer">{file.fileName}（PDF）</a>
      : <div key={file.fileUrl}><Image src={file.fileUrl} width={140} height={110} style={{ objectFit: 'cover' }} alt={file.fileName} /><small>{file.fileName}</small></div>)}</div></Image.PreviewGroup>
    {!files.length && <Empty description="尚未上传证明材料；车辆保持待审核和未授权" />}
    {!!files.length && <Typography.Paragraph type="secondary">点击小图查看大图，滚轮缩放、拖动平移；左右按钮切换，点击空白处或右上角 × 关闭。</Typography.Paragraph>}
    {rejecting && <label>驳回原因（必填）<Input.TextArea value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} placeholder="请说明需补充或不符合要求的资料" /></label>}
  </Modal>;
}
