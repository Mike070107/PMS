import assert from 'node:assert/strict';
import test from 'node:test';
import axios from 'axios';
import { LlmService } from './llm.service';

test('DeepSeek 官方接口启用 JSON Output，V4 抽取关闭思考模式', async () => {
  const original = axios.post;
  let sent: Record<string, unknown> | null = null;
  (axios as any).post = async (_url: string, body: Record<string, unknown>) => {
    sent = body;
    return { data: { choices: [{ message: { content: '{"ok":true}' } }] } };
  };
  try {
    const service = new LlmService({
      getAiAssistRaw: async () => ({
        enabled: true,
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-v4-flash',
        apiKey: 'test-key',
        timeoutMs: 6000,
      }),
    } as any);
    assert.deepEqual(await service.askJson(1, '只输出 JSON', '测试'), { ok: true });
    assert.deepEqual((sent as any)?.response_format, { type: 'json_object' });
    assert.deepEqual((sent as any)?.thinking, { type: 'disabled' });
  } finally {
    (axios as any).post = original;
  }
});

test('其他 OpenAI 兼容服务商不强塞 DeepSeek 专用参数', async () => {
  const original = axios.post;
  let sent: Record<string, unknown> | null = null;
  (axios as any).post = async (_url: string, body: Record<string, unknown>) => {
    sent = body;
    return { data: { choices: [{ message: { content: '{"ok":true}' } }] } };
  };
  try {
    const service = new LlmService({
      getAiAssistRaw: async () => ({
        enabled: true,
        baseUrl: 'http://localhost:11434',
        model: 'local-model',
        apiKey: 'local',
        timeoutMs: 6000,
      }),
    } as any);
    await service.askJson(1, '只输出 JSON', '测试');
    assert.equal('response_format' in (sent || {}), false);
    assert.equal('thinking' in (sent || {}), false);
  } finally {
    (axios as any).post = original;
  }
});


test('抄表识别只用独立配置，v1地址不重复拼接，并设置图像像素下限', async () => {
  const original = axios.post;
  let sent: any, target = '', auth = '';
  (axios as any).post = async (url: string, body: any, opts: any) => {
    target = url; sent = body; auth = opts.headers.Authorization;
    return { data: { choices: [{ message: { content: '{"reading":"12345"}' } }] } };
  };
  try {
    const service = new LlmService({
      getAiAssistRaw: async () => { throw new Error('不应读取维修AI配置'); },
      getMeterVisionRaw: async () => ({ enabled: true, baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model: 'qwen3-vl-plus', apiKey: 'meter-test-key', timeoutMs: 15000 }),
    } as any);
    const result = await service.askImageJson(1, '识别', '读取数字', { contentType: 'image/png', buffer: Buffer.from('image') }, { profile: 'meter' } as any);
    assert.deepEqual(result, { reading: '12345' });
    assert.equal(target, 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
    assert.equal(auth, 'Bearer meter-test-key');
    assert.equal(sent.model, 'qwen3-vl-plus');
    assert.equal(sent.enable_thinking, false);
    assert.equal(sent.messages[1].content[1].min_pixels, 65536);
  } finally { (axios as any).post = original; }
});

test('抄表开关关闭时不调用模型，也不回退到维修密钥', async () => {
  const original = axios.post;
  (axios as any).post = async () => { throw new Error('不应发请求'); };
  try {
    const service = new LlmService({
      getAiAssistRaw: async () => { throw new Error('不应使用维修配置'); },
      getMeterVisionRaw: async () => ({ enabled: false, baseUrl: 'https://example.test/v1', model: 'qwen-vl-ocr', apiKey: 'meter-key' }),
    } as any);
    assert.equal(await service.askImageJson(1, '', '', { contentType: 'image/png', buffer: Buffer.from('image') }, { profile: 'meter' } as any), null);
  } finally { (axios as any).post = original; }
});


test('配置测试必须读对测试图片，文本接口响应不能算视觉成功', async () => {
  const original = axios.post;
  let reading = '99999';
  (axios as any).post = async () => ({ data: { choices: [{ message: { content: JSON.stringify({ reading }) } }] } });
  try {
    const service = new LlmService({ resolveMeterVision: async () => ({ enabled: true, baseUrl: 'https://example.test/v1', model: 'vision', apiKey: 'test-key', timeoutMs: 15000 }) } as any);
    assert.equal((await service.testMeterImage(1)).ok, false);
    reading = '12345';
    assert.equal((await service.testMeterImage(1)).ok, true);
  } finally { (axios as any).post = original; }
});
