import { App as AntdApp, AutoComplete, Button, Col, Form, Image, Input, InputNumber, Row, Space, Tag, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DefaultOptionType } from 'antd/es/select';
import type { MaterialOption } from '@pms/shared-types';
import { request } from '../lib/api';

const { Text } = Typography;

/**
 * 缺料明细录入（工单「标记缺料」「修改缺料」、维修记录里的「等待材料」共用这一份）。
 *
 * 为什么抽出来：缺料这件事有三个入口（还有小程序端的「缺料登记」），
 * 每个入口都要能从材料库挑 SKU、看实物照、挑不到时手填，规则各写一套必然走样。
 * 新增任何要录缺料的地方，直接引这个组件，别再复制 Form.List。
 *
 * 关键规则：**名称被手改就摘掉 materialId**。
 * 选了「PVC 管 DN50」再把字改成「PVC 管 DN75」，若 id 还留着，
 * 采购按 id 买回来的是 DN50，而办公室看到的名字是 DN75 —— 到货才发现买错。
 */
export interface MissingMaterialRow {
  materialId?: number;
  name?: string;
  qty?: number;
  unit?: string;
}

/** 材料库列表在一次会话里反复用到（三个弹窗都要），缓存 5 分钟，避免每开一次弹窗打一次接口 */
let cache: { at: number; rows: MaterialOption[] } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function fetchMaterialOptions(force = false): Promise<MaterialOption[]> {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.rows;
  const rows = await request<MaterialOption[]>({ url: '/materials/options' });
  cache = { at: Date.now(), rows };
  return rows;
}

export function invalidateMaterialOptionsCache() {
  cache = null;
}

function materialText(item: MaterialOption) {
  return item.spec ? `${item.name} ${item.spec}` : item.name;
}

export default function MissingMaterialsInput({
  name = 'missingMaterials',
}: {
  /** Form.List 的字段名，默认 missingMaterials（后端就叫这个） */
  name?: string;
}) {
  const { message } = AntdApp.useApp();
  const form = Form.useFormInstance();
  const [materials, setMaterials] = useState<MaterialOption[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (force = false) => {
      setLoading(true);
      try {
        setMaterials(await fetchMaterialOptions(force));
      } catch (e: any) {
        message.error(e?.message || '材料库加载失败');
      } finally {
        setLoading(false);
      }
    },
    [message],
  );

  useEffect(() => { load(); }, [load]);

  const options = useMemo<DefaultOptionType[]>(
    () =>
      materials.map((item) => ({
        value: materialText(item),
        // 搜索用的纯文本（别名、编码也能搜到），label 是带图的节点没法直接匹配
        keywords: [item.name, item.spec, item.code, item.category, ...(item.aliases || [])]
          .filter(Boolean)
          .join(' ')
          .toLowerCase(),
        material: item,
        label: (
          <Space size={10} align="center">
            {item.photoUrl ? (
              <Image
                src={item.photoUrl}
                width={40}
                height={40}
                style={{ objectFit: 'cover', borderRadius: 4 }}
                preview={false}
                fallback=""
              />
            ) : (
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 4,
                  background: '#f5f5f5',
                  color: 'rgba(0,0,0,.35)',
                  fontSize: 12,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                无图
              </div>
            )}
            <span>
              <div>{materialText(item)}</div>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {item.code} · {item.category || '未分类'} · 单位 {item.unit}
              </Text>
            </span>
          </Space>
        ),
      })),
    [materials],
  );

  /** 选中 SKU：名称、单位、关联 id 一起写进这一行 */
  const applyMaterial = (rowName: number, option?: DefaultOptionType) => {
    const material = option?.material as MaterialOption | undefined;
    const list: MissingMaterialRow[] = form.getFieldValue(name) || [];
    // 一直手打、本来也没关联过 SKU 的行，不用每敲一个字就重写一遍整张表
    if (!material && !list[rowName]?.materialId) return;
    const next = list.slice();
    next[rowName] = {
      ...next[rowName],
      name: material ? materialText(material) : next[rowName]?.name,
      // 手打的名字不对应任何 SKU，关联 id 必须摘掉，否则采购按 id 买的是另一样东西
      materialId: material?.id,
      unit: material ? material.unit : next[rowName]?.unit,
    };
    form.setFieldValue(name, next);
  };

  return (
    <Form.List name={name}>
      {(fields, { add, remove }) => (
        <Space direction="vertical" style={{ width: '100%' }} size={8}>
          {fields.map((field) => (
            <Row key={field.key} gutter={8} align="middle">
              <Col span={11}>
                <Form.Item
                  name={[field.name, 'name']}
                  rules={[{ required: true, message: '请填写材料名称' }]}
                  noStyle
                >
                  <AutoComplete
                    options={options}
                    popupMatchSelectWidth={420}
                    placeholder="材料名称，可从材料库搜索选择"
                    filterOption={(input, option) =>
                      String(option?.keywords || '').includes(input.trim().toLowerCase())
                    }
                    onChange={(_value, option) =>
                      applyMaterial(field.name, Array.isArray(option) ? option[0] : option)
                    }
                    style={{ width: '100%' }}
                  />
                </Form.Item>
              </Col>
              <Col span={4}>
                <Form.Item
                  name={[field.name, 'qty']}
                  rules={[{ required: true, message: '请填数量' }]}
                  noStyle
                >
                  <InputNumber min={0.01} placeholder="数量" style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col span={3}>
                <Form.Item name={[field.name, 'unit']} noStyle>
                  <Input placeholder="单位" />
                </Form.Item>
              </Col>
              <Col span={4}>
                <Form.Item name={[field.name, 'materialId']} noStyle>
                  <MaterialLinkTag />
                </Form.Item>
              </Col>
              <Col span={2}>
                <Button danger size="small" onClick={() => remove(field.name)}>删除</Button>
              </Col>
            </Row>
          ))}
          <Space>
            <Button type="dashed" onClick={() => add({})}>+ 增加材料</Button>
            <Button
              type="link"
              size="small"
              icon={<ReloadOutlined />}
              loading={loading}
              onClick={() => load(true)}
            >
              刚建完 SKU？刷新材料库
            </Button>
          </Space>
          <Text type="secondary">
            材料库里没有的直接手填名称和数量；在「材料 SKU」页补建后回来刷新，重新选一次就能关联上。
          </Text>
        </Space>
      )}
    </Form.List>
  );
}

/** 只读地显示这一行有没有关联到 SKU；本身是个受控组件，好让 materialId 留在表单里 */
function MaterialLinkTag({ value }: { value?: number }) {
  return value ? (
    <Tag color="blue">已关联 SKU</Tag>
  ) : (
    <Tag>手填</Tag>
  );
}
