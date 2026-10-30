import test from 'node:test';
import assert from 'node:assert/strict';
import { wgs84ToGcj02, gcj02ToWgs84, readingMapUrl } from '../src/lib/meter-geo.ts';
test('抄表GCJ02坐标在WGS84底图反算，往返不发生数百米偏移',()=>{const original=[121.47,31.23];const gcj=wgs84ToGcj02(...original);const restored=gcj02ToWgs84(...gcj);assert.ok(Math.abs(restored[0]-original[0])<1e-7);assert.ok(Math.abs(restored[1]-original[1])<1e-7);const url=new URL(readingMapUrl(...gcj));const [lat,lng]=url.searchParams.get('marker').split(',').map(Number);assert.ok(Math.abs(lng-original[0])<1e-7);assert.ok(Math.abs(lat-original[1])<1e-7);});
test('地图不将无效坐标当成0,0，合法0坐标可查看',()=>{assert.equal(readingMapUrl(NaN,31),null);assert.equal(readingMapUrl(121,91),null);assert.ok(readingMapUrl(0,0));});
