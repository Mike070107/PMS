import { Alert, Button, Form, Input, Modal, Space, Typography } from 'antd';
import { CopyOutlined, DatabaseOutlined } from '@ant-design/icons';
import { useEffect } from 'react';
import { accessCardIssuance } from '@pms/api-client';

const { Text } = Typography;
type ParkingOwnerValues = accessCardIssuance.ParkingOwnerValues;

export interface ParkingLegacyOwnerTarget {
  database: 'parking1' | 'parking2';
  externalOwnerId: string;
  pmsUserId: number | null;
  plate: string;
  values: ParkingOwnerValues;
  pmsValues: ParkingOwnerValues | null;
  fieldHints: Partial<Record<keyof ParkingOwnerValues, string | null>>;
}

export default function ParkingLegacyOwnerModal({
  target,
  saving,
  error,
  onClose,
  onSubmit,
}: {
  target?: ParkingLegacyOwnerTarget;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (values: ParkingOwnerValues) => Promise<void>;
}) {
  const [form] = Form.useForm<ParkingOwnerValues>();

  useEffect(() => {
    if (target) form.setFieldsValue(target.values);
  }, [form, target]);

  const copyPmsValues = () => {
    if (target?.pmsValues) form.setFieldsValue(target.pmsValues);
  };

  return (
    <Modal
      title={<Space><DatabaseOutlined />更新旧停车系统住户资料</Space>}
      open={!!target}
      width={640}
      destroyOnHidden={false}
      maskClosable={!saving}
      closable={!saving}
      onCancel={onClose}
      footer={(
        <Space>
          <Button disabled={saving} onClick={onClose}>取消</Button>
          <Button type="primary" loading={saving} onClick={() => void form.submit()}>保存到旧停车系统</Button>
        </Space>
      )}
    >
      {target && <div className="parking-owner-editor">
        <div className="parking-owner-editor-context">
          <div><span>车牌</span><strong>{target.plate}</strong></div>
          <div><span>数据源</span><strong>{target.database === 'parking1' ? '枫桦景苑一期旧库' : '枫桦景苑二期旧库'}</strong></div>
          <div><span>旧库住户</span><strong>#{target.externalOwnerId}</strong></div>
        </div>
        <Alert
          type="info"
          showIcon
          message="保存后由现场数据同步助手直接更新旧停车数据库"
          description="系统会核对当前值、写入后立即读回验证，并在备注末尾保留“操作来源：PMS系统”。若现场资料已被其他人修改，本次保存会停止并提示冲突。"
        />
        {error && <Alert type="error" showIcon message="没有保存" description={error} />}
        {target.pmsValues && <div className="parking-owner-editor-copy">
          <Text type="secondary">已关联 PMS 用户，可先复制 PMS 中的姓名、电话、房号和备注，再核对后保存。</Text>
          <Button icon={<CopyOutlined />} onClick={copyPmsValues}>填入 PMS 资料</Button>
        </div>}
        <Form<ParkingOwnerValues>
          form={form}
          layout="vertical"
          requiredMark={false}
          onFinish={(values) => void onSubmit(values)}
        >
          <Form.Item label="姓名" name="name">
            <Input maxLength={80} placeholder="旧停车系统住户姓名" autoComplete="off" />
          </Form.Item>
          <Form.Item
            label="电话"
            name="phone"
            rules={[{ pattern: /^[0-9+\-\s()]*$/, message: '电话只能包含数字、空格、加号、括号或短横线' }]}
          >
            <Input maxLength={40} placeholder="住户联系电话" inputMode="tel" autoComplete="off" />
          </Form.Item>
          <Form.Item label="房号" name="room">
            <Input maxLength={160} placeholder="例如 228/2/102" autoComplete="off" />
          </Form.Item>
          <Form.Item label="备注" name="note">
            <Input.TextArea maxLength={400} rows={4} showCount placeholder="旧停车系统备注" />
          </Form.Item>
        </Form>
      </div>}
    </Modal>
  );
}
