import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AiExtractSample } from '../../entities';

/**
 * 识别样例库：「这么说 → 应该这么认」。
 *
 * 提示词里的例子写死在代码里的话，每遇到一种新说法都要改代码重新发版，
 * 办公室只能来找开发。放进库里之后谁都能在后台加一条，下一次调用就带上了。
 *
 * 用法是 few-shot（每次调用都把例子给模型看），**不是训练**，所以：
 *   · 条数要克制 —— 每条都摊进每一次调用的费用和延迟里，超过 SAMPLE_LIMIT 只取最近的；
 *   · 每条都要短 —— 一句原话 + 一行期望输出；
 *   · 教错了先关掉（enabled=false），别急着删，回头要能看出当初为什么这么教。
 */
@Injectable()
export class ExtractSamplesService {
  private readonly logger = new Logger(ExtractSamplesService.name);

  /** 带进提示词的上限。再多收益递减，而每条都在给每一次调用加钱加延迟 */
  static readonly SAMPLE_LIMIT = 20;

  constructor(
    @InjectRepository(AiExtractSample)
    private readonly repo: Repository<AiExtractSample>,
  ) {}

  /**
   * 这个租户还一条样例都没有时，把已经验证过的那几条灌进去。
   *
   * **按需灌、不在启动时灌**：启动时还不知道有哪些租户，而且新开的公司也该有种子。
   * 只在「一条都没有」时灌 —— 之后办公室自己加的、改的、关掉的一律不动。
   * 灌失败只记日志：样例是加分项，不能因此让识别整个不可用。
   */
  async ensureSeeded(tenantId: number, kind: string): Promise<void> {
    try {
      const count = await this.repo.count({ where: { tenantId, kind } });
      if (count > 0) return;
      const seeds = kind === 'completion' ? COMPLETION_SEEDS : SEED_SAMPLES;
      await this.repo.save(
        seeds.map((item) =>
          this.repo.create({ ...item, kind, tenantId, enabled: true, createdBy: null, updatedBy: null }),
        ),
      );
      this.logger.log(`租户 ${tenantId} 灌入 ${seeds.length} 条「${kind}」样例种子`);
    } catch (err) {
      this.logger.warn(`识别样例种子灌入失败（不影响识别）：${(err as Error).message}`);
    }
  }

  /** 拼提示词用：启用的、最近更新的若干条 */
  async forPrompt(tenantId: number, kind = 'repair'): Promise<AiExtractSample[]> {
    await this.ensureSeeded(tenantId, kind);
    return this.repo.find({
      where: { tenantId, kind, enabled: true },
      order: { updatedAt: 'DESC' },
      take: ExtractSamplesService.SAMPLE_LIMIT,
    });
  }

  async list(tenantId: number, kind = 'repair'): Promise<AiExtractSample[]> {
    await this.ensureSeeded(tenantId, kind);
    return this.repo.find({ where: { tenantId, kind }, order: { updatedAt: 'DESC' } });
  }

  async create(
    tenantId: number,
    userId: number,
    input: { text: string; expected: Record<string, unknown>; note?: string; kind?: string },
  ): Promise<AiExtractSample> {
    return this.repo.save(
      this.repo.create({
        tenantId,
        kind: input.kind === 'completion' ? 'completion' : 'repair',
        text: input.text.trim(),
        expected: pruneExpected(input.expected),
        note: (input.note ?? '').trim(),
        enabled: true,
        createdBy: userId,
        updatedBy: userId,
      }),
    );
  }

  async update(
    tenantId: number,
    userId: number,
    id: number,
    patch: { text?: string; expected?: Record<string, unknown>; note?: string; enabled?: boolean },
  ): Promise<AiExtractSample> {
    const row = await this.repo.findOne({ where: { id, tenantId } });
    if (!row) throw new NotFoundException('样例不存在');
    if (patch.text !== undefined) row.text = patch.text.trim();
    if (patch.expected !== undefined) row.expected = pruneExpected(patch.expected);
    if (patch.note !== undefined) row.note = patch.note.trim();
    if (patch.enabled !== undefined) row.enabled = patch.enabled;
    row.updatedBy = userId;
    return this.repo.save(row);
  }

  async remove(tenantId: number, id: number): Promise<{ ok: true }> {
    const row = await this.repo.findOne({ where: { id, tenantId } });
    if (!row) throw new NotFoundException('样例不存在');
    await this.repo.remove(row);
    return { ok: true };
  }
}

/** 空字段不写进提示词：教一堆空值会让模型倾向于什么都不填 */
function pruneExpected(expected: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of [
    // 一句话报修
    'addressText',
    'description',
    'contactName',
    'phone',
    'repairType',
    // 完工小结
    'actionNote',
    'faultLocation',
    'faultSymptom',
  ] as const) {
    const v = expected?.[key];
    if (typeof v === 'string' && v.trim()) out[key] = v.trim();
  }
  if (Array.isArray(expected?.materials)) {
    const list = expected.materials.map((m) => String(m).trim()).filter(Boolean);
    if (list.length) out.materials = list;
  }
  if (typeof expected?.urgent === 'boolean') out.urgent = expected.urgent;
  if (typeof expected?.publicArea === 'boolean') out.publicArea = expected.publicArea;
  return out;
}

/**
 * 种子样例 —— **每一条都是生产上真实发生过、并且已经修到对的句子**，
 * 不是编出来的。改动这里只影响「第一次用的租户」，已经在用的不受影响。
 */
const SEED_SAMPLES: Array<{ text: string; expected: Record<string, unknown>; note: string }> = [
  {
    text: '5511弄，236号，502报修电子门里面，旋钮打滑，居民出不来。急急急，13818909545',
    expected: {
      addressText: '5511弄，236号，502',
      description: '电子门旋钮打滑，居民出不去',
      phone: '13818909545',
      urgent: true,
      repairType: 'smart',
    },
    note: '语音把门牌断成三段（弄/号/室之间有逗号）；房号 502 后面直接跟「报修」两个字',
  },
  {
    text: '枫桦一期十七号二零一，家里灯不亮了，找张先生，13800138000',
    expected: {
      addressText: '枫桦一期17号201',
      description: '家里灯不亮',
      contactName: '张先生',
      phone: '13800138000',
      urgent: false,
      repairType: 'electric',
    },
    note: '语音把门牌说成中文数字，要转成阿拉伯数字才撞得上房产库',
  },
  {
    text: '喂那个，我们这边呃，永北5511弄236号502，就是电子门那个旋钮打滑了，居民出不来，麻烦师傅赶紧过来看一下，谢谢啊',
    expected: {
      addressText: '永北5511弄236号502',
      description: '电子门旋钮打滑，居民出不去',
      urgent: true,
      repairType: 'smart',
    },
    note: '整句都是口语：语气词、客套话（麻烦、谢谢）都不该进故障描述',
  },
  {
    text: '5511弄278号503报门口机没有反应18201728748',
    expected: {
      addressText: '5511弄278号503',
      description: '门口机没有反应',
      phone: '18201728748',
      publicArea: true,
      repairType: 'smart',
    },
    note: '门牌是报修人住址、坏的是单元门口机 —— 地址要落到楼栋级公共区域，不能挂到 503 室',
  },
  {
    text: '监控室2号那个显示屏不亮了',
    expected: { addressText: '监控室2号', description: '显示屏不亮', repairType: 'smart' },
    note: '公区点位：「2号」是点位名的一部分，不是门牌号，别当成 2 号楼',
  },
  {
    text: '那个什么，水管漏水了',
    expected: { description: '水管漏水', repairType: 'water' },
    note: '一个字都没提地址时就留空，绝不能编一个门牌出来',
  },
  {
    text: '业主王女士报修，一期47号大门关不上，电话13900139000',
    expected: {
      addressText: '一期47号',
      description: '大门关不上',
      contactName: '王女士',
      phone: '13900139000',
      repairType: 'smart',
    },
    note: '「业主」「报修」这类标签词不属于故障描述',
  },
  {
    text: '枫桦景苑二期25号303家里门铃打不开门',
    expected: {
      addressText: '枫桦景苑二期25号303',
      description: '家里门铃打不开门',
      publicArea: false,
      repairType: 'smart',
    },
    note: '门铃是明确的智能化设备词；「家里」「打不开门」不能把它误判成入户门锁/门窗',
  },
];

/**
 * 完工小结的种子样例。维修工站在现场单手拿手机，说出来的就是这个样子 ——
 * 目标是把它理成办公室和业主都看得懂的一句话，而不是原样记下来。
 */
const COMPLETION_SEEDS: Array<{ text: string; expected: Record<string, unknown>; note: string }> = [
  {
    text: '换了个角阀，原来那个锈死了，顺手把水管接头缠了生料带',
    expected: {
      actionNote: '更换角阀一只；水管接头加缠生料带',
      faultSymptom: '角阀锈蚀卡死',
      materials: ['角阀', '生料带'],
    },
    note: '口述的动作要理成规范的维修说明；用料只提示、仍要自己从库存选',
  },
  {
    text: '就厨房水槽下面那个接头漏水，我给紧了一下，观察了十分钟没再滴',
    expected: {
      actionNote: '紧固厨房水槽下方接头，观察十分钟无渗漏',
      faultLocation: '厨房水槽下方',
      faultSymptom: '接头渗水',
    },
    note: '位置和现象要从话里拆出来各归各的字段，别全塞进维修说明',
  },
  {
    text: '人不在家没进去，改天再约',
    expected: { actionNote: '上门时业主不在家，未能入户，另约时间' },
    note: '没修成也要能提交：只写发生了什么，不要编造维修动作',
  },
];
