import assert from 'node:assert/strict';
import test from 'node:test';
import { AiUsageService, estimateCostYuan, normalizeForCache, readUsage } from './ai-usage.service';

test('结果缓存 key：标点空格不同算同一句，提示词一变 key 就变', () => {
  const sys = '规则 A';
  const k1 = AiUsageService.cacheKey('deepseek-v4-flash', sys, '二期2号802室，门铃坏了。');
  const k2 = AiUsageService.cacheKey('deepseek-v4-flash', sys, '二期2号802室,门铃坏了');
  const k3 = AiUsageService.cacheKey('deepseek-v4-flash', '规则 B', '二期2号802室，门铃坏了。');
  assert.equal(k1, k2, '只差标点/空格的两句要命中同一条缓存');
  assert.notEqual(k1, k3, '样例库或规则变了（系统提示词变）不能再用旧结果');
  assert.equal(normalizeForCache(' 门铃 坏了！ '), '门铃坏了');
});

test('费用估算：没填单价返回 null；填了按未命中/命中/输出三档算', () => {
  const usage = { promptTokens: 3000, promptCacheHitTokens: 2500, completionTokens: 200 };
  assert.equal(estimateCostYuan(usage, {}), null);
  // 未命中 500 × 2 元/M + 命中 2500 × 0.2 元/M + 输出 200 × 3 元/M
  const yuan = estimateCostYuan(usage, { priceInputMissPerM: 2, priceInputHitPerM: 0.2, priceOutputPerM: 3 });
  assert.equal(yuan, Math.round((500 * 2 + 2500 * 0.2 + 200 * 3) / 1_000_000 * 10000) / 10000);
});

test('服务商 usage 字段整理：缺字段补 0，非数字不炸', () => {
  assert.deepEqual(readUsage({ prompt_tokens: 120, completion_tokens: 30 }), {
    promptTokens: 120,
    promptCacheHitTokens: 0,
    completionTokens: 30,
  });
  assert.deepEqual(readUsage({ prompt_tokens: 'x', prompt_cache_hit_tokens: 64 }), {
    promptTokens: 0,
    promptCacheHitTokens: 64,
    completionTokens: 0,
  });
  assert.equal(readUsage(null), null);
});
