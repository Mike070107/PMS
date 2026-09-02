import { BugOutlined } from '@ant-design/icons';
import { App as AntdApp, Alert, Button, Form, Input, Modal, Select, Space, Typography } from 'antd';
import { getLastApiFailure, observability, type FeedbackType } from '@pms/api-client';
import { useState } from 'react';
import { useLocation } from 'react-router-dom';

const { Text } = Typography;

interface FeedbackForm {
  type: FeedbackType;
  message: string;
}

/** 全站反馈入口：用户只写现象，页面、版本和最近请求失败自动附带。 */
export default function FeedbackButton({ pageTitle, compact = false }: { pageTitle: string; compact?: boolean }) {
  const { message } = AntdApp.useApp();
  const location = useLocation();
  const [form] = Form.useForm<FeedbackForm>();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const lastFailure = open ? getLastApiFailure() : null;

  const submit = async () => {
    const values = await form.validateFields();
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
      });
      message.success('已发给后台，页面和错误信息已自动带上');
      setOpen(false);
      form.resetFields();
    } catch (error: any) {
      message.error(error?.message || '反馈提交失败');
    } finally {
      setSubmitting(false);
    }
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
        onCancel={() => setOpen(false)}
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
          </Form>
          <Text type="secondary">系统只会附带页面、版本和最近错误摘要，不会附带表单原文、电话或密码。</Text>
        </Space>
      </Modal>
    </>
  );
}
