import assert from 'node:assert/strict';
import test from 'node:test';
import {
  agentTokenMatches,
  bearerToken,
  issueAgentSecret,
} from './agent-auth';

test('代理密钥只保存 hash，且使用固定时间比较', () => {
  const issued = issueAgentSecret();
  assert.equal(issued.token.length > 30, true);
  assert.equal(issued.tokenHash.length, 64);
  assert.equal(agentTokenMatches(issued.token, issued.tokenHash), true);
  assert.equal(agentTokenMatches(`${issued.token}x`, issued.tokenHash), false);
});

test('只接受标准 Bearer 代理凭据', () => {
  assert.equal(bearerToken('Bearer abc.def'), 'abc.def');
  assert.equal(bearerToken('Basic abc'), '');
  assert.equal(bearerToken(undefined), '');
});
