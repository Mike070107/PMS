import assert from 'node:assert/strict';
import test from 'node:test';
import { legacyDeliyunSign } from './deliyun-parking.service';

test('德立云旧协议签名与参数传入顺序无关', () => {
  const first = legacyDeliyunSign({ version: 'v1', accessKeyID: 'id', data: '{}', timestamp: '1', commKey: 'park' }, 'secret');
  const second = legacyDeliyunSign({ commKey: 'park', timestamp: '1', data: '{}', accessKeyID: 'id', version: 'v1' }, 'secret');
  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{32}$/);
});

test('德立云签名不包含空参数', () => {
  assert.equal(legacyDeliyunSign({ accessKeyID: 'id', optional: '' }, 'secret'), legacyDeliyunSign({ accessKeyID: 'id' }, 'secret'));
});
