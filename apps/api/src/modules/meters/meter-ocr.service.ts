import { BadGatewayException, BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import type { AuthUser } from '../../common/current-user.decorator';
import { Meter } from '../../entities';
import { LlmService } from '../ai/llm.service';
import { ObjectStorageService } from '../upload/object-storage.service';
import {
  digitsToValue,
  normalizeMeterNo,
  normalizeOcrText,
  parseMeterOcr,
  type MeterOcrParsed,
  type OcrBoxItem,
} from './meter-ocr.util';

export interface MeterOcrResponse extends MeterOcrParsed {
  ok: boolean;
  provider: 'sidecar' | 'llm' | 'none';
  meterNoMatched: boolean | null;
  imageUrl: string;
  /** 自动选定的旋转角；原图不旋转，只记录识别时用的方向 */
  orientation: number;
  error?: string;
}

interface SidecarResult {
  parsed: MeterOcrParsed;
  orientation: number;
}

const LLM_SYSTEM =
  '你是物业抄表识别器。只读图里的水表/电表当前读数，输出 JSON，不要解释，不要编造看不清的数字；无法确认的位写?。';
const LLM_PROMPT = `读出这张表照片的当前读数与表号，只输出 JSON：
{"reading":"保留前导零和可见小数点，无法确定的位用?","meterNo":"表身印刷的表号，看不清就给空字符串","confidence":0到100的整数}
规则：
- reading 只要当前累计读数，不要用量、不要单价、不要规格里的数字（如 3×220/380V、R=80、GB/T 标准号）。
- 保留全部前导零；液晶屏可见小数点才保留小数点；水表字轮按窗口内完整数字返回。
- 字轮只读同一排当前数字，不能将上下相邻字轮的过渡数字追加成新位；字轮颜色不作为补小数点的依据。
- 表号是印在表壳/铭牌上的编号（常见 6~12 位），不是读数；看不清或没有就给空字符串。`;

/**
 * 抄表识别编排：
 * 1. 优先走自托管 OCR（tools/meter-ocr-service），不依赖外部账号、按次免费；
 * 2. 自托管不可用或没读出数时，退回租户已配置的多模态大模型；
 * 3. 两条路都不通就返回 ok=false —— 前端必须能继续人工输入，不能把识别失败当业务失败。
 *
 * 识别结果**绝不直接落库**：前端拿它回填输入框，人对着原图确认后才提交。
 */
@Injectable()
export class MeterOcrService {
  private readonly logger = new Logger(MeterOcrService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly storage: ObjectStorageService,
    private readonly llm: LlmService,
  ) {}

  async recognize(
    meter: Meter,
    imageKey: string,
    crop: { x: number; y: number; w: number; h: number } | undefined,
    user: AuthUser,
    roi?: { x: number; y: number; w: number; h: number },
    recognitionImageKey?: string,
  ): Promise<MeterOcrResponse> {
    const buffer = await this.readUpload(imageKey);
    const imageUrl = this.storage.fileUrl(imageKey);
    const base: Omit<MeterOcrResponse, 'ok'> = {
      provider: 'none' as const,
      value: null,
      digits: null,
      confidence: 0,
      meterNo: null,
      meterNoCandidates: [],
      texts: '',
      candidates: [],
      needsReview: true,
      imageUrl,
      meterNoMatched: null as boolean | null,
      orientation: 0,
    };

    // 原图始终保留原 objectKey；只把独立的红框图送给视觉模型。
    if (recognitionImageKey) {
      const recognitionBuffer = await this.readUpload(recognitionImageKey);
      try {
        const parsed = await this.runLlm(meter, recognitionBuffer, user.tenantId ?? 0);
        if (parsed) return this.finish(base, meter, parsed, 'llm');
      } catch {
        this.logger.warn('meter OCR 裁切图视觉识别失败');
      }
      return { ...base, ok: false, error: '裁切图未能可靠识别，请核对画面后重试或手工输入' };
    }

    const sidecarUrl = this.sidecarUrl();
    if (sidecarUrl) {
      try {
        const expected = meter.integerDigits + meter.decimalDigits;
        // 先试 0°（绝大多数照片就是正的）；只有读不出/位数不对才继续转。
        // 这样常见照片只跑一次 OCR，不再固定跑四个方向。
        let best: { found: SidecarResult; score: number } | null = null;
        for (const orientation of [0, 90, 270, 180]) {
          const found = await this.runSidecar(sidecarUrl, buffer, crop, false, meter, orientation, roi);
          const parsed = found.parsed;
          const isMeterNo =
            !!parsed.digits &&
            normalizeMeterNo(parsed.digits) === normalizeMeterNo(meter.meterNo);
          const score = parsed.value === null || isMeterNo
            ? -1
            : parsed.confidence +
              (parsed.digits?.length === expected ? 40 : 0) +
              (parsed.digits?.startsWith('0') ? 5 : 0);
          if (!best || score > best.score) best = { found, score };
          if (
            !isMeterNo &&
            parsed.value !== null &&
            !parsed.needsReview &&
            parsed.digits?.length === expected &&
            parsed.confidence >= 85
          ) {
            return this.finish(base, meter, parsed, 'sidecar', found.orientation);
          }
        }

        if (best && best.score >= 0 && best.found.parsed.value !== null) {
          return this.finish(base, meter, best.found.parsed, 'sidecar', best.found.orientation);
        }

        // 四个方向都没读出数，只对最可能的方向做一次增强，不再把四方向重跑一遍。
        const enhanced = await this.runSidecar(
          sidecarUrl,
          buffer,
          crop,
          true,
          meter,
          best?.found.orientation || 0,
          roi,
        );
        if (enhanced.parsed.value !== null) {
          return this.finish(base, meter, enhanced.parsed, 'sidecar', enhanced.orientation);
        }
        this.logger.warn(`meter OCR sidecar 未读出读数（${meter.id}）：${enhanced.parsed.texts.slice(0, 120)}`);
        base.texts = enhanced.parsed.texts;
        base.candidates = enhanced.parsed.candidates;
        base.meterNoCandidates = enhanced.parsed.meterNoCandidates;
        base.confidence = enhanced.parsed.confidence;
        base.orientation = enhanced.orientation;
        base.needsReview = true;
      } catch (error) {
        this.logger.warn(`meter OCR sidecar 调用失败：${error instanceof Error ? error.message : error}`);
      }
    }

    try {
      const llm = roi ? null : await this.runLlm(meter, buffer, user.tenantId ?? 0);
      if (llm) return this.finish(base, meter, llm, 'llm');
    } catch (error) {
      this.logger.warn(`meter OCR 大模型兜底失败：${error instanceof Error ? error.message : error}`);
    }

    return {
      ...base,
      ok: false,
      needsReview: true,
      error: sidecarUrl
        ? '识别服务暂时不可用，请手工输入读数'
        : '还没有配置识别服务，请手工输入读数；配置方法见 docs/meter-reading.md',
    };
  }

  async health(tenantId?: number): Promise<{ ok: boolean; provider: string; detail?: string }> {
    if (tenantId) {
      const ready = await this.llm.isReady(tenantId, 'meter');
      return { ok: ready, provider: 'llm', detail: ready ? '已配置独立抄表AI，实际效果需用照片核对' : '请在设置中启用并配置“抄表图像识别 AI”' };
    }
    const url = this.sidecarUrl();
    if (!url) return { ok: false, provider: 'none', detail: 'METER_OCR_URL 未配置' };
    try {
      const res = await axios.get(url.replace(/\/ocr\/?$/, '/health'), {
        timeout: 3000,
        headers: this.sidecarHeaders(),
      });
      return { ok: !!res.data?.ok, provider: 'sidecar', detail: String(res.data?.engine || '') };
    } catch (error) {
      return { ok: false, provider: 'sidecar', detail: error instanceof Error ? error.message : '连接失败' };
    }
  }

  private finish(
    base: Omit<MeterOcrResponse, 'ok'>,
    meter: Meter,
    parsed: MeterOcrParsed,
    provider: 'sidecar' | 'llm',
    orientation = 0,
  ): MeterOcrResponse {
    const hint = normalizeMeterNo(meter.meterNo);
    const candidates = parsed.meterNoCandidates.map(normalizeMeterNo);
    const matched =
      parsed.meterNo || candidates.length
        ? hint
          ? candidates.includes(hint) || normalizeMeterNo(parsed.meterNo) === hint
          : null
        : null;
    return {
      ...base,
      ...parsed,
      ok: parsed.value !== null,
      provider,
      meterNoMatched: matched,
      imageUrl: base.imageUrl,
      orientation,
      needsReview:
        parsed.needsReview ||
        parsed.confidence < 75 ||
        (matched === false ? true : false),
    };
  }

  private sidecarUrl(): string {
    return (this.config.get<string>('METER_OCR_URL') || '').trim().replace(/\/+$/, '');
  }

  private sidecarHeaders(): Record<string, string> {
    const token = (this.config.get<string>('METER_OCR_TOKEN') || '').trim();
    return token ? { 'x-meter-ocr-token': token } : {};
  }

  private async runSidecar(
    url: string,
    buffer: Buffer,
    crop: { x: number; y: number; w: number; h: number } | undefined,
    enhance: boolean,
    meter: Meter,
    orientation = 0,
    roi?: { x: number; y: number; w: number; h: number },
  ): Promise<SidecarResult> {
    const res = await axios.post(
      url,
      {
        image: buffer.toString('base64'),
        contentType: 'image/jpeg',
        crop: crop || undefined,
        enhance,
        rotate: orientation,
      },
      {
        timeout: 25000,
        maxBodyLength: 30 * 1024 * 1024,
        headers: this.sidecarHeaders(),
      },
    );
    const data = res.data || {};
    if (data.ok === false) throw new BadGatewayException(String(data.error || 'OCR 服务返回失败'));
    const items: OcrBoxItem[] = Array.isArray(data.items)
      ? data.items
          .slice(0, 300)
          .map((item: any) => ({
            text: String(item?.text ?? ''),
            score: Number(item?.score ?? 0),
            box: Array.isArray(item?.box) ? item.box : undefined,
          }))
          .filter((item: OcrBoxItem) => item.text.trim())
      : [];
    if (!items.length) throw new BadGatewayException('OCR 服务没有返回文字');
    const width = Number(data.width) || undefined;
    const height = Number(data.height) || undefined;
    // 固定红框只用于筛候选，不裁剪原图；框外的表号/绿色标签直接排除。
    const inRoi = roi && width && height
      ? items.filter((item) => {
          const box = item.box;
          if (!box || box.length < 4) return false;
          const cx = (box[0] + box[2]) / 2 / width;
          const cy = (box[1] + box[3]) / 2 / height;
          // 留一点余量，避免用户框得刚好把最左/最右一位切掉。
          const padX = roi.w * 0.08;
          const padY = roi.h * 0.1;
          return (
            cx >= roi.x - padX &&
            cx <= roi.x + roi.w + padX &&
            cy >= roi.y - padY &&
            cy <= roi.y + roi.h + padY
          );
        })
      : [];
    const usable = roi ? inRoi : items;
    // 边车返回原图坐标；拼接字轮前必须恢复到识别方向，否则侧拍会反序/拆行。
    const angle = Number(data.orientation) || orientation;
    const rotateBox = (box: number[], inverse = false): number[] => {
      const [x1, y1, x2, y2] = box;
      const w = Number(width), h = Number(height);
      if (angle === 90) return inverse
        ? [y1, h - 1 - x2, y2, h - 1 - x1]
        : [h - 1 - y2, x1, h - 1 - y1, x2];
      if (angle === 270) return inverse
        ? [w - 1 - y2, x1, w - 1 - y1, x2]
        : [y1, w - 1 - x2, y2, w - 1 - x1];
      if (angle === 180) return [w - 1 - x2, h - 1 - y2, w - 1 - x1, h - 1 - y1];
      return box;
    };
    const canRotate = !!width && !!height;
    const parsed = parseMeterOcr(usable.map((item) => ({
      ...item, box: item.box && canRotate ? rotateBox(item.box) : item.box,
    })), {
      integerDigits: meter.integerDigits,
      decimalDigits: meter.decimalDigits,
      meterNoHint: meter.meterNo,
      width: angle === 90 || angle === 270 ? height : width,
      height: angle === 90 || angle === 270 ? width : height,
    });
    if (canRotate) for (const candidate of parsed.candidates) {
      if (candidate.box) candidate.box = rotateBox(candidate.box, true);
    }
    return { parsed, orientation: angle };
  }

  /**
   * 大模型兜底。这里不直接用 parseMeterOcr：模型返回的是一整句读数，
   * 而且提示词已经要求它带小数点，按文本解析比再造一套框逻辑稳。
   */
  private async runLlm(meter: Meter, buffer: Buffer, tenantId: number): Promise<MeterOcrParsed | null> {
    if (!tenantId) return null;
    const ready = await this.llm.isReady(tenantId, 'meter');
    if (!ready) return null;
    const json = await this.llm.askImageJson<{
      reading?: string;
      meterNo?: string;
      confidence?: number;
      uncertain?: boolean;
    }>(tenantId, LLM_SYSTEM, LLM_PROMPT, { contentType: buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png' : 'image/jpeg', buffer }, { kind: 'meter-ocr', profile: 'meter' });
    if (!json) return null;
    const normalized = normalizeOcrText(String(json.reading ?? '')).replace(/\s+/g, '');
    const explicitDecimal = /[.,]/.test(normalized);
    const bare = normalized.replace(/[^\d]/g, '');
    if (!/^\d+(?:\.\d+)?$/.test(normalized)) return {
      digits: null, value: null, confidence: 0, meterNo: null, meterNoCandidates: [],
      texts: JSON.stringify(json).slice(0, 4000), candidates: [], needsReview: true,
    };
    const value = digitsToValue(normalized, meter.integerDigits, meter.decimalDigits, explicitDecimal);
    if (value === null) return null;
    const confidence = Math.max(0, Math.min(100, Number(json.confidence) || 60));
    return {
      digits: bare,
      value,
      confidence,
      meterNo: normalizeMeterNo(json.meterNo) || null,
      meterNoCandidates: json.meterNo ? [normalizeMeterNo(json.meterNo)] : [],
      texts: JSON.stringify(json).slice(0, 4000),
      candidates: [{ digits: bare, value, score: confidence / 100, text: normalized, explicitDecimal }],
      needsReview: true, // 现场六图证明模型仍会高分误读；视觉草稿必须由人核对。
    };
  }

  private async readUpload(imageKey: string): Promise<Buffer> {
    if (!imageKey || !/^uploads\/[A-Za-z0-9/_\-.]+$/.test(imageKey) || imageKey.includes('..')) {
      throw new BadRequestException('图片地址无效');
    }
    let object: Awaited<ReturnType<ObjectStorageService['getObject']>>;
    try {
      object = await this.storage.getObject(imageKey);
    } catch {
      throw new BadRequestException('原图读取失败，请重新上传');
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of object.stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > 30 * 1024 * 1024) throw new BadRequestException('原图超过 30MB');
      chunks.push(buf);
    }
    if (!chunks.length) throw new BadRequestException('原图为空');
    return Buffer.concat(chunks);
  }
}
