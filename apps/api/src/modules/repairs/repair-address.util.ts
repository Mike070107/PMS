/**
 * 从报修描述里识别地址：「一期24号302」「198弄24号」「二期6号大门关不上」……
 *
 * 思路不是 NLP，而是两步：
 *   1. 正则抽出「N期 / X弄 / Y号 / Z室」候选（这个文件，纯函数可单测）；
 *   2. 拿候选去撞库里真实存在的分期/楼栋/房号（repairs.service.parseRepairAddress）——
 *      撞上了才算识别到，撞不上宁可不填，绝不猜一个地址挂上去。
 *
 * 只说到楼栋就停在楼栋级、别把公区单挂到房号上，这条口径与
 * miniapp 的 utils/place-scope 一致。
 */

export interface RepairAddressCandidate {
  /** 分期，统一成中文写法「一期」；描述里没说就是 null */
  phase: string | null;
  /** 路名，如「剑川路」；描述里没说就是 null */
  roadName: string | null;
  /**
   * 地址数字之前的那段文字，疑似小区名（「枫桦一期17号」→「枫桦」）。
   * 只是候选 —— 撞不上库里的小区名就丢掉，绝不拿它猜地址。
   */
  namePrefix: string | null;
  /** 弄的数字部分，如「198」 */
  lane: string | null;
  /** 号的数字部分，如「24」 */
  buildingNo: string | null;
  /**
   * 「号」字前面**连着的完整数字串**，如「19814号」→「19814」。
   *
   * 为什么不能只看 buildingNo：正则只捕 4 位（`\d{1,4}`），「19814号」捕到的是后四位
   * 「9814」，而真相是「198弄14号」—— 语音把「弄」吞了，弄号和门牌粘成了一个数字。
   * 要拆回去必须拿完整数字串，怎么拆由服务端按库里真实存在的弄号定
   * （splitGluedLaneNo + 撞库）。没粘的时候它就等于 buildingNo。
   */
  gluedNo: string | null;
  /** 室号数字部分，如「302」 */
  roomNo: string | null;
  /**
   * 「号」后面紧跟的那一小段原话，如「858号工程部空调不制冷」→「工程部空调不制冷」。
   *
   * 为什么交出一段而不是「抽出名字」：办公楼、商业体没有「几0几」，房间就叫工程部、
   * 采购部、财务部（2026-09-15 Mike：物业总公司在宝秀路858号）。名字有多长、
   * 到哪里为止，**只有房产库知道** —— 正则去猜必然连着故障描述一起抓走
   * （「858号工程部空调不制冷」抓成「工程部空调不」）。
   * 所以这里只负责把尾巴原样交出去，由服务端拿这栋楼下真实的房号去比对
   * （谁能对上这段开头、就取最长的那个），撞不上一律当没说过。
   */
  roomNameTail: string | null;
  /** 归一化后的命中内容，如「一期24号302室」，给用户看、也用来做「忽略」去重 */
  matchedText: string;
  /**
   * 地址在**原话里**实际占的那一段，如「枫桦景苑一期17号201」。
   *
   * 和 matchedText 的区别：那个是归一化的（补上「室」、去掉小区名），只适合展示；
   * 要从描述里把地址剥干净必须用这一段 —— 否则小区名剥不掉，
   * 「枫桦景苑一期17号201家里灯不亮」的故障描述会剩下「枫桦景苑家里灯不亮」
   * （2026-08-31 实际踩到）。
   */
  matchedRaw: string;
}

const CN_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

/** 「1期」「12期」→「一期」「十二期」，和小区名里的中文写法对齐 */
export function phaseToCn(raw: string): string {
  if (!/^\d+$/.test(raw)) return raw.replace('两', '二');
  const n = Number(raw);
  if (n <= 0 || n > 19) return raw;
  if (n < 10) return CN_DIGITS[n];
  return n === 10 ? '十' : `十${CN_DIGITS[n - 10]}`;
}

const PHASE_RE = /([一二三四五六七八九十两\d]{1,3})期/;
/** 路名：「剑川路」「龙吴路」「塘中路」「前进街」。放在数字之前，长度给足 8 字 */
const ROAD_RE = /([一-龥]{1,8}?(?:大道|路|街|巷|道))(?=[0-9０-９]|[一二三四五六七八九十两]*[弄号])/;
/** 找地址数字段的起点，用来切出前面那段疑似小区名 */
const ADDR_START_RE = /[0-9０-９]|[一二三四五六七八九十两]{1,3}期/;
/** 小区名前后常见的废话，切出来之后剥掉 */
const NAME_NOISE_RE = /^(?:我家在|我家|家住|住在|地址是|地址|位于|在|报修|这里是|这里|那个|那|的)+|(?:的|这边|那边|这里|那里)+$/g;
const LANE_RE = /(\d{1,4})弄/;
/** 「24号」但不是「24号码」；「号楼/栋」的后缀吞掉 */
const BUILDING_RE = /(\d{1,4})号(?!码)(?:楼|栋)?/g;
/**
 * 「XX号」前面两个字是这些词时，号不是门牌号：车位 24 号、工号 8 号……
 * （「门牌24号」是真地址，不拦）
 */
const NO_PREFIX_BLACKLIST = new Set([
  '车位', '车牌', '电话', '手机', '编号', '工号', '单号', '卡号', '证号', '房号',
]);
/**
 * 紧挨在数字前面的这个字是「屋子」，那这个「号」是屋子里第几个东西，不是门牌号：
 * 「监控室2号显示屏」「机房3号柜」。
 * 2026-08-31 线上实测：不拦的话「监控室2号显示屏不亮」会撞上 228弄2号楼，
 * 维修工按地址去 2 号楼白跑一趟。
 */
const PLACE_CHAR_BEFORE_NO = /[室房间厅库]/;
/** 显式室号：302室 / 302房 */
const ROOM_EXPLICIT_RE = /(\d{1,5})\s*[室房](?![屋子])/;

/**
 * 抽出地址候选。至少要有「N期」或「Y号」之一才算候选；
 * 只有一个孤零零的数字（「3个灯泡」）不算。
 */
export function extractAddressCandidate(text: string): RepairAddressCandidate | null {
  const value = String(text || '').trim();
  if (!value) return null;

  const phaseMatch = PHASE_RE.exec(value);
  const phase = phaseMatch ? phaseToCn(phaseMatch[1]) + '期' : null;
  const roadMatch = ROAD_RE.exec(value);
  const roadName = roadMatch ? roadMatch[1] : null;
  const laneMatch = LANE_RE.exec(value);
  const lane = laneMatch ? laneMatch[1] : null;

  let buildingNo: string | null = null;
  let roomNameTail: string | null = null;
  let gluedNo: string | null = null;
  /** 门牌那一段在原话里的起点。粘住时（「19814号」）要从数字串的**头**算起，
      否则剥描述只剥掉正则捕到的「9814号」，前面那个「1」会留在故障描述里 */
  let buildingFrom = -1;
  let roomNo: string | null = null;
  let buildingMatch: RegExpExecArray | null = null;
  BUILDING_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BUILDING_RE.exec(value))) {
    const before = value.slice(Math.max(0, m.index - 2), m.index);
    if (NO_PREFIX_BLACKLIST.has(before)) continue;
    if (PLACE_CHAR_BEFORE_NO.test(value.slice(Math.max(0, m.index - 1), m.index))) continue;
    buildingNo = m[1];
    buildingMatch = m;
    // 「号」前面连着的数字一直往左吃到底：正则最多捕 4 位，粘在一起的弄号要靠这一段才拆得回来
    let digitsFrom = m.index;
    while (digitsFrom > 0 && /\d/.test(value[digitsFrom - 1])) digitsFrom -= 1;
    gluedNo = value.slice(digitsFrom, m.index + m[1].length);
    buildingFrom = digitsFrom;
    /**
     * 跟在「Y号」后面的 3-4 位数字当室号：「24号302」「236号，502」。
     *
     * 允许中间隔一两个分隔符：说话的人在门牌各段之间会停顿，语音转文字就断成
     * 「5511弄，236号，502报修…」——原来要求紧邻，这一句里的 502 就认不出来，
     * 结果地址落成「公共区域」，502 还留在故障描述里（2026-09-01 实际反馈）。
     *
     * 两位以下的裸数字歧义太大（24号3 可能是 3 楼、3 个），必须带「室」才认；
     * 数字后面跟着量词或年月的也不是房号（「12号，2024年装的」「3号，200个」）。
     */
    const rest = value.slice(m.index + m[0].length);
    const bareRoom = /^[\s、,，]{0,2}(\d{3,4})(?![\d年月日号元个台只条根米])/.exec(rest);
    if (bareRoom) roomNo = bareRoom[1];
    /**
     * 没有数字房号时，把「号」后面紧跟的 2-6 个汉字当**名字**候选：
     * 「858号工程部空调不制冷」→「工程部」。办公楼没有「几0几」，房间就叫这个名字。
     * 这里不做任何判断 —— 撞不上这栋楼下真实的房号一律丢掉，
     * 所以「858号漏水了」抽出来的「漏水了」不会有任何副作用。
     */
    if (!bareRoom) {
      const tail = /^[\s、,，]{0,2}([一-龥]{2,12})/.exec(rest);
      if (tail) roomNameTail = tail[1];
    }
    break;
  }
  if (!roomNo) {
    const explicit = ROOM_EXPLICIT_RE.exec(value);
    if (explicit) roomNo = explicit[1];
  }

  if (!phase && !buildingNo) return null;
  // 室号必须挂在楼栋号下面才有意义；只说「302室」没法定位到哪栋楼
  if (!buildingNo) roomNo = null;

  const matchedText = [
    phase ?? '',
    lane ? `${lane}弄` : '',
    buildingNo ? `${buildingNo}号` : '',
    roomNo ? `${roomNo}室` : '',
  ].join('');
  const namePrefix = extractNamePrefix(value, roadName);
  const matchedRaw = sliceMatchedRaw(value, {
      namePrefix,
      roadName,
      phaseMatch,
      laneMatch,
      buildingMatch,
      buildingFrom,
      roomNo,
  });
  return {
    phase,
    roadName,
    namePrefix,
    matchedRaw,
    lane,
    buildingNo,
    gluedNo,
    roomNo,
    roomNameTail,
    matchedText,
  };
}

/**
 * 语音把「弄」吞掉、弄号和门牌粘成一个数字时，按库里**真实存在的弄号**把它拆回去：
 * 「1984号」+ 库里有 198 弄 → 拆成「198弄4号」。
 *
 * 2026-09-14 线上实测的那条：说「198弄4号门口监控黑屏」，识别出来是
 * 「1984号门口监控黑屏」，规则拿 1984 去找楼栋，一栋都找不到 —— 报修人只好改口说
 * 「枫桦一期14号」才认得出，等于「说弄就不行」。「弄」在口语里读 lòng、前后都是数字，
 * 是最容易被识别丢掉的一个字，这条兜底不能少。
 *
 * 这里**只出候选，不做判断**：拆出来的「弄+号」还要去撞真实楼栋，撞不上、
 * 或者撞出好几栋，一律当没认出来（见 repairs.service 的 parseAddressByRule）。
 * 口径和这个文件里其它函数一致 —— 宁可不认，也不能猜一个地址让师傅白跑一趟。
 */
export function splitGluedLaneNo(
  digits: string | null | undefined,
  lanes: Array<string | null | undefined>,
): Array<{ lane: string; buildingNo: string }> {
  const value = String(digits ?? '').trim();
  // 最短也要「两位弄 + 一位号」；太长的不是门牌，是电话或卡号
  if (!/^\d{3,8}$/.test(value)) return [];
  const seen = new Set<string>();
  const out: Array<{ lane: string; buildingNo: string }> = [];
  for (const raw of lanes) {
    const lane = String(raw ?? '').trim();
    if (!/^\d{2,4}$/.test(lane) || !value.startsWith(lane)) continue;
    const rest = value.slice(lane.length);
    // 门牌号 1-3 位，且不以 0 开头 —— 「1980号」拆成「198弄0号」是凑出来的，没有 0 号楼
    if (!/^[1-9]\d{0,2}$/.test(rest)) continue;
    const key = `${lane}|${rest}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ lane, buildingNo: rest });
  }
  return out;
}

/**
 * 地址在原话里占的区间 —— 从最靠前的那个片段（小区名 / 路名 / 期 / 弄 / 号）
 * 一直到最靠后的（室号）。剥描述时按这一段剥，小区名才不会剩下。
 *
 * 只取**连续的一段**：起点到终点之间的原文原样返回，中间的「弄」「号楼」
 * 「2单元」这些连接字自然包含在内，不用再去猜写法。
 */
function sliceMatchedRaw(
  value: string,
  parts: {
    namePrefix: string | null;
    roadName: string | null;
    phaseMatch: RegExpExecArray | null;
    laneMatch: RegExpExecArray | null;
    buildingMatch: RegExpExecArray | null;
    /** 门牌数字串的真正起点（粘住时比 buildingMatch.index 更靠左）；-1 = 没有 */
    buildingFrom: number;
    roomNo: string | null;
  },
): string {
  const spans: Array<[number, number]> = [];
  const push = (index: number | undefined, len: number) => {
    if (index === undefined || index < 0 || !len) return;
    spans.push([index, index + len]);
  };
  if (parts.roadName) push(value.indexOf(parts.roadName), parts.roadName.length);
  if (parts.namePrefix) push(value.indexOf(parts.namePrefix), parts.namePrefix.length);
  push(parts.phaseMatch?.index, parts.phaseMatch?.[0].length ?? 0);
  push(parts.laneMatch?.index, parts.laneMatch?.[0].length ?? 0);
  if (parts.buildingMatch) {
    const from = parts.buildingFrom >= 0 ? parts.buildingFrom : parts.buildingMatch.index;
    push(from, parts.buildingMatch.index + parts.buildingMatch[0].length - from);
  }
  // 室号可能是「号」后面紧跟的裸数字，也可能带「室」，一律按它在原文的位置算
  if (parts.roomNo) {
    const from = parts.buildingMatch ? parts.buildingMatch.index : 0;
    const at = value.indexOf(parts.roomNo, from);
    // 「201室」把「室」也算进去，剥完不留一个孤零零的「室」
    const tail = value.slice(at + parts.roomNo.length, at + parts.roomNo.length + 1);
    push(at, parts.roomNo.length + (tail === '室' || tail === '房' ? 1 : 0));
  }
  if (!spans.length) return '';
  const start = Math.min(...spans.map((s) => s[0]));
  const end = Math.max(...spans.map((s) => s[1]));
  return value.slice(start, end);
}

/**
 * 切出地址数字之前那段疑似小区名。
 *
 * 「枫桦一期17号201灯不亮」→「枫桦」；「剑川路198弄3号」→ 路名已单独抽走，这里给 null。
 * 只是候选：调用方必须拿它去撞库里真实的小区名，撞不上就当没说过 ——
 * 语音识别把「枫桦」听成「风华」是常事，绝不能拿这段文字去猜地址。
 */
function extractNamePrefix(value: string, roadName: string | null): string | null {
  const start = ADDR_START_RE.exec(value);
  if (!start || start.index === 0) return null;
  let head = value.slice(0, start.index);
  if (roadName) head = head.replace(roadName, '');
  // 只留中文；标点、英文、空格都不是小区名的一部分
  const runs = head.split(/[^一-龥]+/).filter(Boolean);
  let name = runs.length ? runs[runs.length - 1] : '';
  name = name.replace(NAME_NOISE_RE, '');
  // 太短（1 字）判不出是不是小区名，太长（>8 字）多半把整句话捞进来了
  if (name.length < 2 || name.length > 8) return null;
  return name;
}

/**
 * 语音把小区名听成同音字时，用撞库撞出来的正名换回去：
 * 「风华一期17号201灯不亮」→「枫桦景苑一期17号201灯不亮」。
 *
 * 只在这三条同时成立时才动，其余一律返回 null（宁可留着错字，也不能改错）：
 *   1. 说了小区名（namePrefix 有值）；
 *   2. 这个名字**撞不上**库里任何小区 —— 说对了就没什么好改的；
 *   3. 地址是靠**数字**（分期 / 弄）定位到的 —— 数字比名字可靠得多。
 *      只有「7号」这种孤零零的门牌撞出来的小区不算数，那本来就可能撞到别家去。
 *
 * 连着分期一起换：原句「风华一期」里的「一期」已经包含在库名「枫桦景苑一期」里，
 * 只换「风华」会得到「枫桦景苑一期一期17号」。
 */
export function correctCommunityNameInText(
  text: string,
  candidate: RepairAddressCandidate,
  communityName: string,
  matchedByNumber: boolean,
): string | null {
  const prefix = candidate.namePrefix;
  if (!prefix || !matchedByNumber || !communityName) return null;
  // 说对了（哪怕只是库名的一部分）就不动人家的话
  if (communityName.includes(prefix) || prefix.includes(communityName)) return null;

  // 「风华一期」→ 整段换成库名；库名本身不含这个分期时才把分期留下
  const phase = candidate.phase;
  if (phase && text.includes(prefix + phase)) {
    const replacement = communityName.endsWith(phase) ? communityName : communityName + phase;
    return text.replace(prefix + phase, replacement);
  }
  if (!text.includes(prefix)) return null;
  return text.replace(prefix, communityName);
}

/**
 * 拿候选文字去撞库里真实的小区名 —— 「判断口径的唯一出处」，
 * 报修的语音识别和后台录房产的地址拆分都走这一个函数。
 *
 * 只做包含关系，不做同音：「枫桦」对得上「枫桦景苑一期」，
 * 「风华」（识别错的同音字）一律撞不上，此时退回按「期/弄/号」定位 ——
 * 宁可不认，也不能把单派到别的小区去。
 */
export function matchCommunityByName<T extends { id: number; name: string }>(
  text: string | null | undefined,
  communities: T[],
): T[] {
  const key = String(text || '').trim();
  if (key.length < 2) return [];
  const hit = communities.filter((c) => c.name.includes(key) || key.includes(c.name));
  return hit;
}

/**
 * 整句话里直接出现了哪个小区名。
 *
 * 为什么不能只有 matchCommunityByName：那一条是拿 extractAddressCandidate 圈出来的
 * namePrefix 去撞的，而 extractAddressCandidate **没有「期」也没有「号」就直接返回 null**
 * （见函数里 `if (!phase && !buildingNo) return null`）。纯公区报修一个门牌数字都没有：
 *
 *   「上海新家门卫室的道闸没有网络」
 *
 * 小区名根本没机会参与匹配，点位于是在全公司范围里找「门卫室」，撞到别人家去了 ——
 * 2026-09-11 线上实测返回的是「永南5511弄 门卫室」，单子直接派到了另一个管理处。
 * 说出口的小区名必须比点位名优先，这是这个函数存在的全部理由。
 *
 * 口径和 matchCommunityByName 一致：只做包含、不做同音、不做分词，宁可不认；
 * 区别是名字最长的独赢（「吴泾新村二期」压过「吴泾新村」），因为这里拿到的是整句话，
 * 短名字必然被长名字一起命中。
 */
export function matchCommunityInText<T extends { id: number; name: string }>(
  text: string | null | undefined,
  communities: T[],
): T[] {
  const value = String(text || '');
  if (!value.trim()) return [];
  const hits = communities.filter((c) => c.name.length >= 2 && value.includes(c.name));
  if (!hits.length) return [];
  const longest = Math.max(...hits.map((c) => c.name.length));
  return hits.filter((c) => c.name.length === longest);
}

/** 非数字房号的房产（办公楼的「工程部」），整句匹配时只需要这几个字段 */
export interface NamedRoomLike {
  id: number;
  roomNo: string;
  buildingId: number;
  communityId: number;
}

/**
 * 整句话里直接念出来的**房间名**：「财务部空调不制冷」→ 财务部。
 *
 * 为什么要单独一条：办公楼的房间没有「几0几」，一个门牌数字都不说的时候
 * extractAddressCandidate 直接返回 null（`if (!phase && !buildingNo) return null`），
 * 房号根本没机会参与匹配 —— 报修人明明把地方说清楚了，系统还要他自己再选一遍位置
 * （2026-09-15 Mike：物业总公司在宝秀路858号，里面是工程部、采购部、财务部）。
 *
 * 口径和 matchSpotsInText 一模一样：只做包含、不做同音、不做分词；名字最长的赢；
 * 同名房间可能在好几个小区，这里全部返回，由调用方按报修人所在小区收敛，
 * 收敛不掉就当没认出来 —— 认成隔壁小区的「财务部」比不认更糟。
 */
export function matchNamedRoomsInText<T extends NamedRoomLike>(
  text: string,
  rooms: T[],
): T[] {
  const value = String(text || '');
  if (!value.trim()) return [];
  const hits = rooms.filter(
    (r) => r.roomNo && r.roomNo.length >= 2 && !/^\d+$/.test(r.roomNo) && value.includes(r.roomNo),
  );
  if (!hits.length) return [];
  const longest = Math.max(...hits.map((r) => r.roomNo.length));
  return hits.filter((r) => r.roomNo.length === longest);
}

/**
 * 「N号」后面那段尾巴是哪个真实房号：「工程部空调不制冷」+ 这栋楼有「工程部」→ 工程部。
 *
 * 只认**从头对上**的（房号名必然紧跟在门牌后面说），最长的赢；
 * 对不上就返回 null —— 「858号漏水了」的尾巴谁也对不上，自然就当没说过房号。
 */
export function pickNamedRoomFromTail<T extends { roomNo: string }>(
  tail: string | null | undefined,
  rooms: T[],
): T | null {
  const value = String(tail || '').trim();
  if (value.length < 2) return null;
  const hits = rooms.filter(
    (r) => r.roomNo && r.roomNo.length >= 2 && !/^\d+$/.test(r.roomNo) && value.startsWith(r.roomNo),
  );
  if (!hits.length) return null;
  return hits.reduce((best, item) => (item.roomNo.length > best.roomNo.length ? item : best));
}

/** 公区点位（community_spots）匹配时只需要这几个字段 */
export interface SpotLike {
  id: number;
  name: string;
  communityId: number;
  buildingId: number | null;
}

/**
 * 描述里出现了哪个公区点位：「监控室2号显示屏不亮」→ 监控室。
 *
 * 为什么要有它：识别只认「期/弄/号/室」这种数字模式，监控室、门卫室、水泵房这些
 * 地方压根没有房号，说得再清楚也认不出来 —— 更糟的是「监控室2号」里的「2号」
 * 会被当成门牌号撞到 2 号楼去（2026-08-31 线上实测过）。
 *
 * 口径：
 * - 只做包含匹配，不做同音、不做分词 —— 和 matchCommunityByName 一样宁可不认；
 * - 名字最长的赢：「电梯机房」和「机房」都命中时取「电梯机房」，更精确的那个；
 * - 同名点位可能挂在多个小区（每个小区都有门卫室），这里全部返回，
 *   由调用方按报修人所在小区收敛；收敛不掉就当没认出来，
 *   认成隔壁小区的门卫室比不认更糟。
 */
export function matchSpotsInText<T extends SpotLike>(
  text: string,
  spots: T[],
): T[] {
  const value = String(text || '');
  if (!value.trim()) return [];
  const hits = spots.filter((s) => s.name && s.name.length >= 2 && value.includes(s.name));
  if (!hits.length) return [];
  const longest = Math.max(...hits.map((s) => s.name.length));
  return hits.filter((s) => s.name.length === longest);
}

/** 「024」和「24」当同一个号；楼栋表里存的是数字串，这里统一成十进制比较 */
export function sameNo(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = String(a ?? '').replace(/[号栋楼弄室房]/g, '').trim();
  const right = String(b ?? '').replace(/[号栋楼弄室房]/g, '').trim();
  if (!left || !right) return false;
  if (left === right) return true;
  return /^\d+$/.test(left) && /^\d+$/.test(right) && Number(left) === Number(right);
}

// ---------------- 类型纠错的关键词候选 ----------------

/** 这些字出现在词里基本是句子成分而不是名词，不适合当关键词 */
const CANDIDATE_STOP_CHARS = /[的了吗吧呢啊呀哦嘛么我你他她它这那哪请帮谢麻烦师傅一二三四五六七八九十]/;

/**
 * 管理员更正工单类型时，从描述里挑出可以「学」进新类型的候选词。
 *
 * 做法：先把地址片段（期/弄/号/室）和数字剥掉，剩下的中文按 2-3 字滑窗切词，
 * 含原类型命中关键词字符的排前面 —— 典型场景是「门」误判进门窗类，
 * 候选里的「大门」就排在最前，管理员点一下就把「大门」学进公共设施类。
 * 这里只出候选，学不学、学哪个由管理员决定（半自动，可解释可撤销）。
 */
export function extractKeywordCandidates(
  content: string,
  matchedOldKeywords: string[],
  limit = 8,
): string[] {
  const stripped = String(content || '')
    // 地址片段和数字对分类没有意义，先剥掉，免得「24号」被切成候选
    .replace(/[0-9０-９]+\s*[期弄号栋楼室房]?/g, ' ')
    .replace(/[一二三四五六七八九十两]+[期弄号栋楼室]/g, ' ');
  const runs = stripped.split(/[^一-龥]+/).filter((run) => run.length >= 2);
  const oldChars = new Set(matchedOldKeywords.join(''));

  const seen = new Set<string>();
  const scored: Array<{ word: string; score: number }> = [];
  for (const run of runs) {
    for (const size of [2, 3]) {
      for (let i = 0; i + size <= run.length; i += 1) {
        const word = run.slice(i, i + size);
        if (seen.has(word) || CANDIDATE_STOP_CHARS.test(word)) continue;
        seen.add(word);
        let score = 0;
        // 和误判来源沾边的词优先：那正是要「掰过来」的词
        if ([...word].some((ch) => oldChars.has(ch))) score += 4;
        // 靠前的词更可能是主语（坏的东西在句子开头说）
        if (i === 0) score += 2;
        // 双字词优先：更像名词，配置页里也更通用
        if (size === 2) score += 1;
        scored.push({ word, score });
      }
    }
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.word);
}

/**
 * 「198/47/201」「198弄47号201室」「198-47-201」→ ['198', '47', '201']。
 * 和 packages/shared-types/src/address.ts 的 tokenizeAddress 同一套切分规则（API 不依赖那个包，这里抄一份），
 * 工单池搜索按段依次模糊匹配 楼栋(弄/号)+房号。改规则两边一起改。
 */
export function tokenizeAddress(input: string): string[] {
  return input
    .trim()
    .replace(/[弄号室栋幢座楼单元]/g, '/')
    // 连字符必须放在字符类最后：写成 \\- 会变成「\ 到 —」的范围，连字符本身反而不算分隔符
    // （2026-08-27 线上验收发现 228-51 查不到）。共享包那份写的是 \\\-，含义一样。
    .split(/[/\\—－_·,，、。:：;；#＃\s-]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}
