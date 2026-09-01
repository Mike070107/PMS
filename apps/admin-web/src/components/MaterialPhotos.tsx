import { App as AntdApp, Button, Image, Typography, Upload } from 'antd';
import type { UploadProps } from 'antd/es/upload/interface';
import { UploadOutlined } from '@ant-design/icons';
import { useState } from 'react';
import { auth } from '../lib/auth';
import { compressImageFile } from '../lib/compressImage';

/**
 * 材料实物照片：**一条 SKU 最多 4 张**，上传、缩略图、点开看大图三件事只在这里实现一次。
 *
 * 为什么是共用组件而不是各页各写：材料 SKU 有两个入口（「材料 SKU 库」页和
 * 「库存与采购 → 基础资料 → 材料SKU」），以前各写了一份单图上传，
 * 改一处另一处就漏。新入口直接引这里。
 *
 * 4 张的来历见后端 InventoryService.MATERIAL_PHOTO_LIMIT（正面/侧面/铭牌/包装），
 * 改上限要两边一起改。
 */
export const MATERIAL_PHOTO_LIMIT = 4;

const { Text } = Typography;
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api/v1';

interface UploadResponse {
  objectKey?: string;
  publicUrl?: string;
  displayUrl?: string;
}

export function uploadFileUrl(objectKey: string) {
  return `${API_BASE_URL}/upload/file?key=${encodeURIComponent(objectKey)}`;
}

function uploadObjectKey(url?: string | null) {
  if (!url || url.startsWith('blob:') || url.startsWith('data:')) return '';
  try {
    const parsed = new URL(url, window.location.origin);
    const key = parsed.searchParams.get('key');
    if (parsed.pathname.endsWith('/upload/file') && key) return key;
    const pathKey = parsed.pathname.replace(/^\/+/, '');
    if (pathKey.startsWith('uploads/')) return pathKey;
  } catch {
    if (url.startsWith('uploads/')) return url;
  }
  return '';
}

/** 存库用的地址：COS 直连地址私有桶取不到，一律换成后端代理地址 */
export function normalizePhotoUrl(url?: string | null) {
  const key = uploadObjectKey(url);
  return key ? uploadFileUrl(key) : (url || '');
}

/** 页面上显示用的地址 */
export function imageSrc(url?: string | null) {
  if (!url) return '';
  if (url.startsWith('blob:') || url.startsWith('data:') || url.includes('/upload/file?key=')) return url;
  return normalizePhotoUrl(url);
}

/** 一条记录可能只有老的单图字段，也可能已经有多图；统一取成数组 */
export function materialPhotoList(item?: { photoUrl?: string | null; photoUrls?: string[] | null } | null): string[] {
  if (!item) return [];
  const list = (item.photoUrls || []).filter(Boolean);
  if (list.length) return list;
  return item.photoUrl ? [item.photoUrl] : [];
}

/**
 * 表格里的照片单元格：只占一张缩略图的位置，点开是**整组**大图，可左右翻。
 * 其余几张渲染成隐藏的 Image —— antd 的 PreviewGroup 靠子节点组队，
 * 不渲染它们就翻不到第二张。
 */
export function MaterialPhotoCell({
  item,
  size = 64,
}: {
  item?: { photoUrl?: string | null; photoUrls?: string[] | null } | null;
  size?: number;
}) {
  const urls = materialPhotoList(item);
  if (!urls.length) return <Text type="secondary">未上传</Text>;
  return (
    <Image.PreviewGroup>
      <div style={{ position: 'relative', width: size, height: size }}>
        <Image
          src={imageSrc(urls[0])}
          width={size}
          height={size}
          style={{ objectFit: 'cover', borderRadius: 6 }}
        />
        {urls.length > 1 && (
          <span
            style={{
              position: 'absolute', right: 2, bottom: 2, padding: '0 6px',
              borderRadius: 10, background: 'rgba(0,0,0,0.55)', color: '#fff',
              fontSize: 12, lineHeight: '18px', pointerEvents: 'none',
            }}
          >
            {urls.length}
          </span>
        )}
      </div>
      {/* 组队用，不占位 */}
      {urls.slice(1).map((url) => (
        <Image key={url} src={imageSrc(url)} style={{ display: 'none' }} />
      ))}
    </Image.PreviewGroup>
  );
}

/**
 * 多图上传（value/onChange 为 string[]，直接给 Form.Item 用）。
 * onUploadingChange 让外面在上传途中禁用「保存」，否则点太快会存下空地址。
 */
export function MaterialPhotosUpload({
  value,
  onChange,
  onUploadingChange,
  max = MATERIAL_PHOTO_LIMIT,
}: {
  value?: string[];
  onChange?: (urls: string[]) => void;
  onUploadingChange?: (uploading: boolean) => void;
  max?: number;
}) {
  const { message } = AntdApp.useApp();
  const [pending, setPending] = useState(0);
  const urls = value || [];
  const full = urls.length >= max;

  const bumpPending = (delta: number) => {
    setPending((current) => {
      const next = Math.max(0, current + delta);
      onUploadingChange?.(next > 0);
      return next;
    });
  };

  const uploadProps: UploadProps<UploadResponse> = {
    name: 'file',
    action: `${API_BASE_URL}/upload`,
    headers: auth.getToken() ? { Authorization: `Bearer ${auth.getToken()}` } : undefined,
    accept: 'image/*',
    multiple: true,
    showUploadList: false,
    // 返回 Promise<File> 时 antd 传的是这里返回的那个文件 —— 压缩就挂在这一步，
    // 长边缩到 1600、重新编码，几 MB 的原图通常降到几百 KB（见 lib/compressImage.ts）
    beforeUpload: async (file, fileList) => {
      if (!/^image\//i.test(file.type || '')) {
        message.error('只能上传照片');
        return Upload.LIST_IGNORE;
      }
      if (file.size / 1024 / 1024 > 10) {
        message.error('照片不能超过 10MB');
        return Upload.LIST_IGNORE;
      }
      // 一次多选也要守住上限：超出的直接丢掉，别等服务端截断
      const room = max - urls.length;
      if (fileList.indexOf(file) >= room) {
        message.warning(`最多 ${max} 张照片`);
        return Upload.LIST_IGNORE;
      }
      bumpPending(1);
      return compressImageFile(file);
    },
    onChange: ({ file }) => {
      if (file.status === 'done') {
        const url = file.response?.displayUrl
          || (file.response?.objectKey ? uploadFileUrl(file.response.objectKey) : file.response?.publicUrl);
        if (url) {
          const next = normalizePhotoUrl(url);
          // urls 取的是这一轮渲染的快照，多张并发上传时要以最新值为准，否则只留下最后一张
          onChange?.(Array.from(new Set([...(value || []), next])).slice(0, max));
        }
        bumpPending(-1);
      } else if (file.status === 'error') {
        bumpPending(-1);
        message.error(`${file.name} 上传失败`);
      }
    },
  };

  return (
    /*
      这里不能用 <Space wrap>：Space 只把**直接子节点**各自包一层 .ant-space-item，
      而 Image.PreviewGroup 自身不渲染任何 DOM —— 于是四张图会被塞进同一个 item 里
      竖着叠成一列（2026-09-01 截图里就是这样）。用普通 flex 容器，
      PreviewGroup 的孩子才是真正的 flex 项。
    */
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start' }}>
      <Image.PreviewGroup>
        {urls.map((url, index) => (
          <div key={url} style={{ position: 'relative' }}>
            <Image
              src={imageSrc(url)}
              width={88}
              height={88}
              style={{ objectFit: 'cover', borderRadius: 6 }}
            />
            <Button
              size="small"
              danger
              style={{ position: 'absolute', top: -8, right: -8, padding: '0 6px' }}
              onClick={() => onChange?.(urls.filter((_, i) => i !== index))}
            >
              ×
            </Button>
            {index === 0 && (
              <span
                style={{
                  position: 'absolute', left: 2, bottom: 2, padding: '0 6px',
                  borderRadius: 10, background: 'rgba(0,0,0,0.55)', color: '#fff',
                  fontSize: 12, lineHeight: '18px', pointerEvents: 'none',
                }}
              >
                封面
              </span>
            )}
          </div>
        ))}
      </Image.PreviewGroup>
      {!full && (
        <Upload {...uploadProps}>
          <div
            style={{
              width: 88, height: 88, border: '1px dashed #bbb', borderRadius: 6,
              display: 'flex', flexDirection: 'column', alignItems: 'center',
              justifyContent: 'center', cursor: 'pointer', color: '#888',
            }}
          >
            <UploadOutlined />
            <span style={{ fontSize: 12, marginTop: 4 }}>
              {pending > 0 ? '上传中…' : `${urls.length}/${max}`}
            </span>
          </div>
        </Upload>
      )}
    </div>
  );
}
