import assert from 'node:assert/strict';
import test from 'node:test';
import { QrService } from './qr.service';

for (const name of ['永南140弄', '永南150弄', '永北150弄']) {
  test(`二维码文案裁相邻重复弄号，保留小区身份：${name}`, () => {
    const service = Object.create(QrService.prototype) as any;
    const building = Object.freeze({ id: 11, lane: name.includes('140') ? '140' : '150', buildingNo: '6' });
    assert.equal(service.buildCaption(name, building), `${name}6号 · 扫码报修`);
    assert.equal(building.id, 11);
    assert.equal(service.buildCaption(name, null), `${name} · 扫码报修`);
  });
}
test('二维码文案不同弄号不能误删', () => {
  const service = Object.create(QrService.prototype) as any;
  assert.equal(service.buildCaption('永南1150弄', { lane: '150', buildingNo: '6' }), '永南1150弄 150弄6号 · 扫码报修');
});
