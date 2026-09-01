import {
  App as AntdApp,
  Col,
  Form,
  Input,
  Modal,
  Row,
  Select,
  Typography,
} from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { request } from '../lib/api';
import { searchableWideSelectProps, withOptionTitles } from '../lib/selectProps';

// 业主档案的新增/编辑弹窗。抽成单独文件是因为「业主用户」页和房产页都要用到
// 同一份地址搜索与字段校验 —— 各写一套迟早两边不一致。
export interface OwnerRow {
  id: number;
  name: string | null;
  phone: string | null;
  status: 'active' | 'disabled';
  /** 这条档案怎么来的：manual 后台建 / self 业主认证 / repair_intake 报修登记 / legacy_import 老系统导入 */
  source: string | null;
  /** 手机号之外的联系方式（固话、第二个号码）。老系统导入的档案很多只有固话 */
  contactNote?: string | null;
  houseId: number | null;
  house: {
    id: number;
    roomNo: string;
    areaSqm: string | null;
    lane: string | null;
    buildingNo: string;
    communityId: number | null;
    communityName: string | null;
  } | null;
}

interface HouseOption {
  id: number;
  roomNo: string;
  lane: string | null;
  buildingNo: string;
  communityName: string;
  owner: { id: number; name: string | null; phone: string | null } | null;
}

/** 「枫桦景苑 · 198 弄 2 号 101 室」——列表和下拉共用一套写法 */
export function formatOwnerLocation(h: {
  communityName: string;
  lane: string | null;
  buildingNo: string;
  roomNo: string;
}) {
  return `${h.communityName} · ${h.lane ? h.lane + ' 弄 ' : ''}${h.buildingNo} 号 ${h.roomNo} 室`;
}

export default function OwnerFormModal({
  open, target, onClose, onDone,
}: {
  open: boolean;
  target?: OwnerRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [houseOptions, setHouseOptions] = useState<HouseOption[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (target) {
      form.setFieldsValue({
        name: target.name,
        phone: target.phone,
        contactNote: target.contactNote ?? undefined,
        houseId: target.houseId,
      });
      if (target.house) {
        setHouseOptions([{
          id: target.house.id,
          roomNo: target.house.roomNo,
          lane: target.house.lane,
          buildingNo: target.house.buildingNo,
          communityName: target.house.communityName || '-',
          owner: null,
        }]);
      }
    } else {
      form.resetFields();
      setHouseOptions([]);
    }
  }, [open, target, form]);

  const searchHouses = useMemo(() => {
    let t: any = null;
    return (kw: string) => {
      if (t) clearTimeout(t);
      t = setTimeout(async () => {
        setSearching(true);
        try {
          const q = kw.trim();
          const parts = q.split(/[\/\\\-\s]+/).map((p) => p.trim()).filter(Boolean);
          const queries = [q];
          if (parts.length === 3) {
            queries.push(`${parts[0]} ${parts[1]} ${parts[2]}`);
            queries.push(`${parts[0]}弄${parts[1]}号${parts[2]}室`);
          }
          const results = await Promise.all(
            Array.from(new Set(queries.filter(Boolean))).map((item) =>
              request<HouseOption[]>({ url: '/houses', query: { q: item } }).catch(() => []),
            ),
          );
          const map = new Map<number, HouseOption>();
          results.flat().forEach((item) => map.set(item.id, item));
          setHouseOptions(Array.from(map.values()));
        } catch { /* ignore */ } finally { setSearching(false); }
      }, 250);
    };
  }, []);

  const onOk = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        name: v.name,
        phone: v.phone,
        contactNote: v.contactNote || null,
        houseId: v.houseId ?? null,
      };
      if (target) {
        await request({ method: 'PATCH', url: `/owners-mgmt/${target.id}`, data: payload });
        message.success('已保存');
      } else {
        await request({ method: 'POST', url: '/owners-mgmt', data: payload });
        message.success('业主已建档');
      }
      onDone();
    } catch (e: any) {
      message.error(e?.message || '保存失败');
    } finally { setSaving(false); }
  };

  return (
    <Modal
      title={target ? `编辑业主：${target.name?.trim() || '未填姓名'}` : '新增业主'}
      open={open}
      onCancel={onClose}
      onOk={onOk}
      confirmLoading={saving}
      destroyOnHidden
      width={520}
    >
      <Form form={form} layout="vertical">
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="name" label="姓名" rules={[{ required: true }]}>
              <Input />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              name="phone"
              label="手机号"
              rules={[
                { required: true, message: '请填写手机号' },
                { pattern: /^1[3-9]\d{9}$/, message: '请填写正确的手机号' },
              ]}
            >
              <Input />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item
          name="contactNote"
          label="其他联系方式（选填）"
          extra="固话、第二个号码、「找子女」这类备注。老系统导入的档案不少只有固话，先留在这里，核实到手机号再填上面那格。"
        >
          <Input maxLength={255} placeholder="如：64508498（固话）" />
        </Form.Item>
        <Form.Item
          name="houseId"
          label="绑定房产（可后续再绑）"
          extra="可输入小区名、完整地址，或用 198/2/101 格式搜索 198弄2号101室"
        >
          <Select
            {...searchableWideSelectProps}
            allowClear
            placeholder="如：198/2/101"
            filterOption={false}
            loading={searching}
            onSearch={searchHouses}
            options={withOptionTitles(houseOptions.map((h) => ({
              value: h.id,
              label: `${formatOwnerLocation(h)}${h.owner ? ' · 已被占用' : ''}`,
              disabled: !!h.owner && h.owner.id !== target?.id,
            })))}
          />
        </Form.Item>
        {target && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            这个人还是保安 / 居委会 / 业委会 / 物业工作人员？那是员工端小程序的身份，
            请去「用户管理」单独建一条 —— 两个端各自独立，业主档案这边不受影响。
          </Typography.Text>
        )}
      </Form>
    </Modal>
  );
}
