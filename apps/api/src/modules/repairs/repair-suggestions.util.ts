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

// ---------------- 从原话里抽「具体位置」和「报修内容」的关键信息 ----------------
//
// 「猜你想输」原来把历史输入原样贴出来：位置栏出现「枫桦景苑二期/228弄2号大门」，
// 内容栏出现「对，一期47号大门关不上」。门牌在「报修人房号」那一栏已经填过了，
// 位置栏真正要的只是「大门」；内容栏要的是「大门关不上」，语气词、人名、电话、门牌都不该进来
// （2026-08-28 反馈）。下面这几个函数只做抽取，不做分类；聚类和排序仍走上面那套。

/**
 * 场所词表：报修「具体位置」真正想说的是这些。长词在前，保证「地下车库」不被「车库」抢先。
 * 词表按物业场景维护，新场所直接加进来。
 */
export const SPOT_LEXICON: string[] = [
  '非机动车库', '地下车库', '地下室', '停车场', '电动车棚', '车棚', '车库',
  '单元门口', '单元门', '大门口', '大门', '门口', '门岗', '门卫室', '门卫', '岗亭', '门厅', '大堂', '门禁', '道闸',
  '楼梯间', '楼梯', '楼道', '走廊', '过道', '电梯厅', '电梯间', '电梯口', '电梯',
  '天台', '屋顶', '楼顶', '屋面', '外墙', '外立面', '雨棚',
  '垃圾箱房', '垃圾房', '垃圾站', '垃圾桶', '水泵房', '配电房', '配电间', '消防通道', '消防栓', '消防箱',
  '监控室', '物业办公室', '会所', '门房',
  '绿化带', '草坪', '花坛', '儿童乐园', '健身区', '广场', '人行道', '路面', '道路', '井盖', '路灯', '围墙', '围栏', '栏杆',
  '卫生间', '洗手间', '厕所', '浴室', '厨房', '阳台', '客厅', '卧室', '餐厅', '书房', '储藏室', '阁楼', '窗台',
  '入户门', '房门', '窗户', '楼下', '楼上',
].sort((a, b) => b.length - a.length);

const CN_NUM = '\\d一二三四五六七八九十两';

/**
 * 剥掉门牌：小区名、N期、N弄、N号（楼/栋/幢）、N室、N单元、「公共区域」这类范围词和分隔符。
 * 楼层（「4楼」「3层」）不剥 —— 「4楼电梯口」的「4楼」是位置的一部分，「5号楼」的「楼」跟着「号」走。
 * knownPlaces 传本公司的小区名，名字里没有「苑/园/小区」字样的小区靠它兜底。
 */
export function stripAddress(text: string, knownPlaces: string[] = []): string {
  let s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const names = knownPlaces
    .map((n) => String(n ?? '').trim())
    .filter((n) => n.length >= 2)
    .sort((a, b) => b.length - a.length);
  for (const name of names) s = s.split(name).join(' ');
  s = s
    .replace(new RegExp(`[一-龥]{2,}(?:小区|苑|花园|公寓|大厦|新村|家园|山庄|别墅|园区|广场)(?:[${CN_NUM}]+期)?`, 'g'), ' ')
    .replace(new RegExp(`[${CN_NUM}]+期`, 'g'), ' ')
    .replace(new RegExp(`[${CN_NUM}]+弄`, 'g'), ' ')
    // 「17号201」：号后面紧跟的 3-4 位裸数字是室号，得和「号」一起剥。
    // **必须排在下面那条「N号」前面** —— 先把「17号」剥走，201 就成了孤零零的
    // 数字，后面所有规则都认不出它是室号，于是「枫桦景苑一期17号201家里灯不亮」
    // 归纳出来是「201家里灯不亮」（2026-08-31 实测）
    .replace(/[\d一二三四五六七八九十两]+号(?:楼|栋|幢)?\s*\d{3,4}(?!\d)/g, ' ')
    .replace(new RegExp(`[${CN_NUM}]+号(?:楼|栋|幢)?`, 'g'), ' ')
    .replace(new RegExp(`[${CN_NUM}]+(?:室|栋|幢|单元)`, 'g'), ' ')
    .replace(/公共区域|公区/g, ' ')
    .replace(/[\/／\\|—_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s;
}

/** 一句话里最先出现的场所词（同位置取更长的），前面紧挨的楼层一起带上：「4楼电梯口」 */
export function findSpotWord(text: string): string {
  const s = String(text ?? '');
  let best: { idx: number; word: string } | null = null;
  for (const word of SPOT_LEXICON) {
    const idx = s.indexOf(word);
    if (idx < 0) continue;
    if (!best || idx < best.idx || (idx === best.idx && word.length > best.word.length)) {
      best = { idx, word };
    }
  }
  if (!best) return '';
  const floor = s.slice(0, best.idx).match(new RegExp(`([${CN_NUM}]+(?:楼|层))$`));
  return `${floor ? floor[1] : ''}${best.word}`;
}

/**
 * 从「具体位置」或整条地址里抽位置本身。
 * 剥掉门牌后剩下的短语就是位置（「枫桦景苑二期/228弄2号 大门」→「大门」）；
 * 剩下的还是一长句（语音原话）就只认词表里的场所词。
 */
export function extractSpot(text: string, knownPlaces: string[] = []): string {
  const rest = stripAddress(text, knownPlaces).replace(/^[，。、,.]+|[，。、,.]+$/g, '').trim();
  if (!rest) return '';
  if (rest.length <= 8 && !/[，。！？,.!?；;]/.test(rest)) return rest;
  return findSpotWord(rest);
}

/** 句子里像故障的迹象：有这些词的一句才是「报修内容」，「说没有吗」这种不是 */
const FAULT_HINT =
  /(坏|不|漏|堵|停|断|裂|掉|响|臭|没|失灵|故障|损|松|卡|锁|异味|噪音|渗|冒|翘|塌|积水|打不开|关不上|不亮|无|换|修|坏了|短路|跳闸|漏电|漏水|滴水|生锈|脱落|破)/;

/**
 * 从报修原话里抽真正的内容：剥门牌、电话、人名/称呼、「报修」「麻烦看一下」这类客套、语气词，
 * 语音里重复说的句子只留一句，再从剩下的句子里挑最像故障描述的那句（有故障词的优先，同分取短的）。
 * 和 packages/shared-types/voice-extract.ts 的 extractFaultDescription 是同一思路，
 * 那份跑在小程序里、要靠认出来的地址/电话去剥；这份跑在服务端、面对的是已经落库的原文，
 * 只能靠模式，所以单独实现，API 也不在运行时依赖 shared-types。
 */
export function extractContentGist(text: string, knownPlaces: string[] = []): string {
  let s = stripAddress(text, knownPlaces);
  if (!s) return '';
  s = s
    /* 按「≥10 位连续数字」整串剥，不卡死 11 位 —— 卡死了会在语音多听一位的
       「138000138000」里只吃掉前 11 位，把孤零零一个 0 留在内容里
       （「家里灯不亮，0」，2026-08-31 实测）。
       端上那份 voice-extract.ts 的同一处是一样的改法，两边要一起改。
       房号是「17号201」这种被单位字隔开的短数字，够不到 10 位，不会误伤。 */
    .replace(/(?<!\d)\d(?:[\s-]*\d){9,}(?!\d)/g, ' ')
    .replace(/[零〇一幺二两三四五六七八九]{7,}/g, ' ')
    .replace(/(联系电话|联系方式|电话号码|手机号码|手机号|电话|手机|号码)(是|为|：|:)?/g, ' ')
    // 「彭经理，」「侯队」「张师傅」：称呼连着前面 1~3 个字的姓名一起剥
    .replace(/[一-龥]{1,3}(经理|师傅|先生|女士|小姐|队长|主任|老师|阿姨|大爷|大妈|同志|书记|主管|队)(?=[，,、：:\s]|$)/g, ' ')
    .replace(/(联系人|户主|业主|住户|租户|物业|保安|居委会|业委会|门岗|门卫)(是|为|：|:)?/g, ' ')
    .replace(/(来?报修的?|报的修|报了个修|报个修|报的|报单|报一下|反映|投诉|说是|说的)/g, ' ')
    // 「报一期12号大门的密码」剥掉门牌后剩「报 大门的密码」：孤零零的「报」也是引导词
    .replace(/(^|[，,、\s])报(?=[一-龥\s])/g, '$1 ')
    .replace(/(麻烦|请|帮忙|希望|尽快|赶紧|抓紧|派人|派个人|安排人|安排|能不能|可不可以)+(过来|来|上门|上来)?(看一下|看一看|看看|看下|修一下|修修|修下|修理一下|修理|处理一下|处理下|处理|弄一下|弄下|解决一下|解决下|解决)?/g, ' ')
    .replace(/(谢谢|麻烦了|辛苦了|拜托了|拜托|按住说话|说没有吗|有没有|听得到吗)/g, ' ')
    .replace(/(地址是|地址|位置是|位置)(：|:)?/g, ' ')
    .replace(/(呃|嗯|啊|哦|哎|呀|吧|呢|嘛|喔|唉|那个|就是|然后|反正|其实|的话|对啊|对的|好的|好了)/g, ' ')
    .replace(/(^|[，,、。\s])(对|好|行|嗯嗯)(?=[，,、。\s]|$)/g, '$1 ')
    .replace(/(^|[，,、。\s])的(?=[一-龥])/g, '$1');

  const parts = s
    .split(/[，。！？,.!?；;\s]+/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 2 && p.length <= 16);
  const uniq = parts.filter((p, i) => parts.indexOf(p) === i);
  if (!uniq.length) return '';
  const score = (p: string) => (FAULT_HINT.test(p) ? 2 : 0) + (findSpotWord(p) ? 1 : 0);
  // 相邻两句拼起来放得下、且各自都有点信息的，也算候选：
  // 「大门的密码」+「需要换一下」拼成「大门的密码需要换一下」，比任何一半都说得清
  const joined: string[] = [];
  for (let i = 0; i + 1 < uniq.length; i += 1) {
    const both = `${uniq[i]}${uniq[i + 1]}`;
    if (both.length <= 16 && score(uniq[i]) > 0 && score(uniq[i + 1]) > 0) joined.push(both);
  }
  return [...uniq, ...joined].sort((a, b) => score(b) - score(a) || a.length - b.length)[0];
}
