// ---------------- 「猜你想输」：从历史报修内容里归纳常用短语 ----------------

/**
 * 各报修类型的种子常用词。只在租户首次初始化报修类型时写进
 * repair_type_rules.content_suggestions，之后由后台「报修类型配置」维护，
 * 这里的改动不会再覆盖已有数据。
 */
export const SEED_CONTENT_SUGGESTIONS: Record<string, string[]> = {
  water: ['水管漏水', '下水道堵塞', '马桶堵了', '水龙头坏了', '热水器不出热水'],
  electric: ['灯不亮', '插座没电', '跳闸推不上去', '开关坏了', '楼道灯不亮'],
  door_window: ['门锁打不开', '门关不上', '窗户关不严', '纱窗坏了', '玻璃破了', '合页松动'],
  appliance: ['空调不制冷', '油烟机不转', '洗衣机不排水', '燃气灶打不着火', '热水器打不着火'],
  elevator: ['电梯故障', '电梯困人', '电梯按键失灵', '电梯有异响', '电梯门关不上'],
  smart: [
    '门禁刷不开',
    '大门按键坏',
    '大门关不上',
    '大门锁不上',
    '可视对讲无声音',
    '可视对讲无画面',
    '道闸不抬杆',
    '监控看不了',
    '车牌识别不了',
  ],
  public: ['楼道灯不亮', '路面破损', '井盖松动损坏', '绿化需修剪', '垃圾桶损坏', '自行车挡道', '垃圾需要清扫'],
  other: ['异味', '噪音', '野蛮装修', '需要师傅上门看一下'],
};

/**
 * 维修说明的常用话术种子。
 *
 * 维修工在现场用手机打字，写「更换了什么、处理了什么」很费劲，多数人干脆不写，
 * 业主那边就只看到一个「已完成」。这里按报修类型给出可点选的短句，
 * 点一下填进去，再自己补细节。
 *
 * 只是冷启动用的兜底：真正展示的顺序由历史维修说明归纳出来（见 summarizeActionNotes），
 * 用得越多的话术排得越前，系统越用越顺手。
 */
export const SEED_ACTION_SUGGESTIONS: Record<string, string[]> = {
  water: [
    '更换水龙头阀芯',
    '更换水龙头',
    '更换角阀',
    '更换软管',
    '重新缠生料带止漏',
    '疏通下水管道',
    '疏通马桶',
    '更换马桶配件',
    '紧固管件接头',
    '更换水管破损段',
  ],
  electric: [
    '更换灯管',
    '更换灯泡',
    '更换镇流器',
    '更换开关面板',
    '更换插座面板',
    '重新接线并测试正常',
    '复位空开、排查短路',
    '更换空开',
  ],
  door_window: [
    '更换门锁锁芯',
    '更换门锁',
    '调整锁舌位置',
    '门锁加油润滑',
    '更换合页',
    '紧固合页螺丝',
    '调整门扇、关闭正常',
    '更换闭门器',
    '更换纱窗纱网',
    '更换窗户执手',
    '调整窗户滑轮',
    '重新打胶密封',
  ],
  appliance: [
    '清洗滤网',
    '加注制冷剂',
    '更换电池',
    '清理管路、排水正常',
    '重新接线并测试正常',
    '更换电机',
    '联系厂家上门保修',
  ],
  elevator: [
    '已通知电梯维保单位到场',
    '现场安抚并配合救援',
    '复位后运行正常',
  ],
  smart: [
    '重启设备后恢复正常',
    '重新录入门禁卡',
    '更换门禁读头',
    '更换电源模块',
    '重新接线并测试正常',
    '调整摄像头角度',
    '重新配置车牌识别',
  ],
  public: [
    '更换楼道灯',
    '修补路面破损',
    '加固井盖',
    '修剪绿化',
    '清运垃圾',
    '更换垃圾桶',
  ],
  other: ['现场查看并处理', '已协调相关单位处理', '现场清理干净'],
};

/**
 * 跨类型都能用的兜底话术。
 *
 * 租户会自建报修类型（「门铃/对讲/门禁/监控/道闸 问题」这种编码是 menjing），
 * 种子表里没有它的桶、历史又还没攒出数据 —— 不兜底的话这类工单的话术区就是一片空白，
 * 等于这个功能对新租户完全不存在。
 */
export const COMMON_ACTION_SUGGESTIONS: string[] = [
  '现场查看并处理',
  '更换损坏配件',
  '重新接线并测试正常',
  '紧固松动螺丝',
  '清理疏通后恢复正常',
  '重启设备后恢复正常',
  '调试后运行正常',
  '已协调相关单位处理',
  '需要材料，已登记待采购',
  '现场清理干净',
];

/** 维修说明话术一次最多给这么多个，多了在手机上要划半天 */
export const MAX_ACTION_SUGGESTIONS = 12;

/** 只回溯最近这么多条报修，避免全表扫 */
export const SUGGESTION_SCAN_LIMIT = 3000;
/** 能贴成标签的短句长度区间，超出的是具体描述，不复用 */
const SUGGESTION_MIN_LEN = 2;
const SUGGESTION_MAX_LEN = 16;
/** 「我家水管漏水」「水管漏水」应归成一类 */
const SUGGESTION_PREFIXES = /^(我家|我们家|家里|我的|本人|请问|麻烦|师傅|你好|您好)+/;
/** 首尾标点与句末语气词 */
const SUGGESTION_EDGE_PUNCT = /^[\s，。、！？!?,.;；：:~～·\-—_"'“”‘’()（）]+|[\s，。、！？!?,.;；：:~～·\-—_"'“”‘’()（）]+$/g;
const SUGGESTION_TAIL_MODAL = /(了|啦|哦|呢|吧|呀|啊)+$/;

export type SuggestionBucket = Map<
  string,
  { variants: Map<string, number>; count: number; latest: number }
>;

/** 关键词最多存这么多个，避免前端一屏铺不下 */
export const MAX_CONTENT_SUGGESTIONS = 20;

/** 后台提交的关键词列表：去空白、去重、限长、限量，顺序按提交的来（后台可拖动调序） */
export function normalizeSuggestionList(list: string[]): string[] {
  const picked: string[] = [];
  for (const raw of list) {
    const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 30) continue;
    if (picked.includes(text)) continue;
    picked.push(text);
    if (picked.length >= MAX_CONTENT_SUGGESTIONS) break;
  }
  return picked;
}

/** 归一化出聚类键：去空白/首尾标点/句末语气词/「我家」这类前缀 */
export function normalizeSuggestionText(text: string): string {
  let value = text.replace(/\s+/g, '').replace(SUGGESTION_EDGE_PUNCT, '');
  value = value.replace(SUGGESTION_PREFIXES, '');
  value = value.replace(SUGGESTION_TAIL_MODAL, '');
  value = value.replace(SUGGESTION_EDGE_PUNCT, '').toLowerCase();
  if (value.length < SUGGESTION_MIN_LEN || value.length > SUGGESTION_MAX_LEN) return '';
  return value;
}

export function collectSuggestion(
  bucket: SuggestionBucket,
  key: string,
  original: string,
  createdAt: Date | string | null | undefined,
) {
  const display = original.replace(SUGGESTION_EDGE_PUNCT, '').trim();
  if (!display) return;
  const at = createdAt ? new Date(createdAt).getTime() : 0;
  const hit = bucket.get(key);
  if (!hit) {
    bucket.set(key, {
      variants: new Map([[display, 1]]),
      count: 1,
      latest: at,
    });
    return;
  }
  hit.variants.set(display, (hit.variants.get(display) ?? 0) + 1);
  hit.count += 1;
  if (at > hit.latest) hit.latest = at;
}

/** 每一类挑出现最多的原文当展示文案（同频取更短的那个），再按热度+新鲜度排序 */
export function rankSuggestions(bucket: SuggestionBucket, limit: number) {
  return Array.from(bucket.values())
    .map((item) => {
      const [text] = Array.from(item.variants.entries()).sort(
        (a, b) => b[1] - a[1] || a[0].length - b[0].length,
      )[0];
      return { text, count: item.count, latest: item.latest };
    })
    .sort((a, b) => b.count - a.count || b.latest - a.latest)
    .slice(0, limit)
    .map(({ text, count }) => ({ text, count }));
}
