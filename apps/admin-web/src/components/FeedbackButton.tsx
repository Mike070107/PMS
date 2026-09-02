import { BugOutlined, PlusOutlined } from '@ant-design/icons';
import { App as AntdApp, Alert, Button, Form, Input, Modal, Select, Space, Typography, Upload } from 'antd';
import type { UploadFile, UploadProps } from 'antd/es/upload/interface';
import { getLastApiFailure, observability, type FeedbackType } from '@pms/api-client';
import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { auth } from '../lib/auth';
import { compressImageFile } from '../lib/compressImage';

const { Text } = Typography;

interface FeedbackForm {
  type: FeedbackType;
  message: string;
}

interface UploadResponse { publicUrl?: string; displayUrl?: string }
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api/v1';

function isVideo(file: { type?: string; name?: string }) {
  return /^video\//i.test(file.type || '') || /\.(mp4|mov)(?:$|\?)/i.test(file.name || '');
}

function isImage(file: { type?: string; name?: string }) {
  return /^image\//i.test(file.type || '') || /\.(jpe?g|png|gif|webp|heic)(?:$|\?)/i.test(file.name || '');
}

/** 全站反馈入口：用户只写现象，页面、版本和最近请求失败自动附带。 */
export default function FeedbackButton({ pageTitle, compact = false }: { pageTitle: string; compact?: boolean }) {
  const { message } = AntdApp.useApp();
  const location = useLocation();
  const [form] = Form.useForm<FeedbackForm>();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [files, setFiles] = useState<UploadFile<UploadResponse>[]>([]);
  const lastFailure = open ? getLastApiFailure() : null;

  const submit = async () => {
    const values = await form.validateFields();
    if (files.some((file) => file.status === 'uploading')) {
      message.warning('附件还在上传，请稍候');
      return;
    }
    if (files.some((file) => file.status === 'error')) {
      message.error('有附件上传失败，请删除后重试');
      return;
    }
    const attachments = files.flatMap((file) => {
      const url = file.response?.displayUrl || file.response?.publicUrl || file.url;
      return url ? [{ type: isVideo(file) ? 'video' as const : 'image' as const, url }] : [];
    });
    setSubmitting(true);
    try {
      await observability.feedback({
        source: 'admin-web',
        type: values.type,
        message: values.message.trim(),
        route: `${location.pathname}${location.search}`.slice(0, 200),
        pageTitle,
        version: import.meta.env.VITE_APP_VERSION || '',
        errorMessage: lastFailure?.message,
        context: lastFailure ? { ...lastFailure } : undefined,
        attachments,
      });
      message.success('已发给后台，页面和错误信息已自动带上');
      setOpen(false);
      form.resetFields();
      setFiles([]);
    } catch (error: any) {
      message.error(error?.message || '反馈提交失败');
    } finally {
      setSubmitting(false);
    }
  };

  const uploadProps: UploadProps<UploadResponse> = {
    name: 'file',
    action: `${API_BASE_URL}/upload`,
    headers: auth.getToken() ? { Authorization: `Bearer ${auth.getToken()}` } : undefined,
    accept: 'image/*,video/mp4,video/quicktime,.mov',
    multiple: true,
    listType: 'picture-card',
    fileList: files,
    beforeUpload: async (file, selectedFiles) => {
      const video = isVideo(file);
      const image = isImage(file);
      if (!image && !video) {
        message.error('只能上传图片或 MP4/MOV 视频');
        return Upload.LIST_IGNORE;
      }
      const acceptedBefore = selectedFiles.slice(0, selectedFiles.indexOf(file) + 1);
      const currentImages = files.filter(isImage).length;
      const currentVideos = files.filter(isVideo).length;
      const selectedImages = acceptedBefore.filter(isImage).length;
      const selectedVideos = acceptedBefore.filter(isVideo).length;
      if ((!video && currentImages + selectedImages > 4) || (video && currentVideos + selectedVideos > 1)) {
        message.warning('反馈最多上传 4 张图片和 1 个视频');
        return Upload.LIST_IGNORE;
      }
      if (file.size / 1024 / 1024 > (video ? 50 : 10)) {
        message.error(video ? '视频不能超过 50MB' : '单张图片不能超过 10MB');
        return Upload.LIST_IGNORE;
      }
      return image ? compressImageFile(file) : true;
    },
    onChange: ({ file, fileList }) => {
      if (file.status === 'error') message.error(`${file.name} 上传失败`);
      setFiles(fileList.map((item) => ({
        ...item,
        url: item.response?.displayUrl || item.response?.publicUrl || item.url,
      })));
    },
    onPreview: (file) => {
      const url = file.response?.displayUrl || file.response?.publicUrl || file.url;
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
    },
  };

  return (
    <>
      <Button
        className="pms-feedback-trigger"
        icon={<BugOutlined />}
        onClick={() => {
          form.setFieldsValue({ type: getLastApiFailure() ? 'error' : 'suggestion' });
          setOpen(true);
        }}
      >{compact ? null : '反馈异常'}</Button>
      <Modal
        title="反馈问题"
        open={open}
        okText="提交反馈"
        cancelText="取消"
        confirmLoading={submitting}
        onOk={() => void submit()}
        onCancel={() => { setOpen(false); setFiles([]); form.resetFields(); }}
        destroyOnClose
      >
        <Space direction="vertical" size={14} style={{ width: '100%' }}>
          <Alert
            type="info"
            showIcon
            message={`当前页面：${pageTitle}`}
            description={location.pathname}
          />
          {lastFailure && (
            <Alert
              type="warning"
              showIcon
              message="已附带最近一次请求错误"
              description={<Text ellipsis={{ tooltip: lastFailure.message }}>{lastFailure.message}</Text>}
            />
          )}
          <Form form={form} layout="vertical" preserve={false} initialValues={{ type: 'error' }}>
            <Form.Item name="type" label="问题类型" rules={[{ required: true }]}>
              <Select options={[
                { value: 'error', label: '页面报错/操作失败' },
                { value: 'hard_to_use', label: '不好用/找不到功能' },
                { value: 'data_issue', label: '数据显示不对' },
                { value: 'suggestion', label: '改进建议' },
                { value: 'other', label: '其他' },
              ]} />
            </Form.Item>
            <Form.Item
              name="message"
              label="发生了什么"
              rules={[
                { required: true, message: '请简单说明问题' },
                { min: 5, message: '至少写 5 个字，便于复现' },
              ]}
            >
              <Input.TextArea rows={5} maxLength={1000} showCount placeholder="例如：点「确认派单」后一直转圈，重试两次都一样" />
            </Form.Item>
            <Form.Item label="现场图片/视频（选填）" extra="最多 4 张图片和 1 个视频；图片会自动压缩，视频最大 50MB。">
              <Upload {...uploadProps}>
                {files.length < 5 && <button type="button" className="pms-feedback-upload-button"><PlusOutlined /><span>添加附件</span></button>}
              </Upload>
            </Form.Item>
          </Form>
          <Text type="secondary">系统只会附带页面、版本和最近错误摘要，不会附带表单原文、电话或密码。</Text>
        </Space>
      </Modal>
    </>
  );
}
