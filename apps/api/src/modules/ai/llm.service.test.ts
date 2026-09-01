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
