import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildParkingRoomOptions,
  firstValidParkingPeriod,
  groupParkingVehicleRows,
  normalizeParkingDate,
  normalizeManualParkingRoom,
  normalizeParkingRoomIdentity,
  parkingRenewalTargets,
  sameParkingText,
} from '../src/lib/parkingVehicleMerge.ts';

const row = (database, plate, id) => ({ database, plate, id });

test('新增车牌房号直接来自 PMS 房产树，可区分一期二期并搜索姓名', () => {
  const options = buildParkingRoomOptions([
    { id: 1, name: '枫桦景苑一期', parentId: null, isGroup: false, mainLane: '198', buildings: [
      { id: 11, lane: '198', buildingNo: '6', roadName: null, houses: [{ id: 111, roomNo: '501', propertyType: '', shopName: null, ownerId: 9, ownerName: '张三', ownerPhone: '13800000000' }] },
    ] },
    { id: 2, name: '枫桦景苑二期', parentId: null, isGroup: false, mainLane: '228', buildings: [
      { id: 22, lane: '228', buildingNo: '3', roadName: null, houses: [{ id: 222, roomNo: '102', propertyType: '', shopName: null, ownerId: 10, ownerName: '李四', ownerPhone: null }] },
    ] },
  ]);
  assert.deepEqual(options.map(({ roomKey, database }) => ({ roomKey, database })), [
    { roomKey: '198/6/501', database: 'parking1' },
    { roomKey: '228/3/102', database: 'parking2' },
  ]);
  assert.match(options[0].searchText, /6\/501.*张三/);
});

test('新增车牌可手工登记不在 PMS 房产清单里的住户，并准确确定旧库', () => {
  assert.deepEqual(normalizeManualParkingRoom('198弄8号102室'), { database: 'parking1', roomKey: '198/8/102' });
  assert.deepEqual(normalizeManualParkingRoom('228-08-0102'), { database: 'parking2', roomKey: '228/8/102' });
  assert.equal(normalizeManualParkingRoom('8/102'), null);
  assert.equal(normalizeManualParkingRoom('36/502'), null);
  assert.equal(normalizeManualParkingRoom('228/8'), null);

  const page = readFileSync(new URL('../src/pages/ParkingManagementPage.tsx', import.meta.url), 'utf8');
  assert.match(page, /residentMode === 'manual'/, '正式新增车牌窗口必须提供手动登记分支');
  assert.match(page, /pmsUserId: undefined/, '手动登记不应伪造 PMS 用户关联');
  assert.match(page, /ownerAddress: normalizedManualRoom!\.roomKey/, '手动房号必须使用标准化值提交');
});

test('同车牌在一期、二期各一条时合并为一张卡片', () => {
  const groups = groupParkingVehicleRows([
    row('parking1', '沪 A0A998', '11'),
    row('parking2', '沪a0a998', '22'),
  ], (item) => item.plate, (item) => item.id);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].merged, true);
  assert.equal(groups[0].parking1?.id, '11');
  assert.equal(groups[0].parking2?.id, '22');
  assert.deepEqual(parkingRenewalTargets(groups[0]).map((item) => item.id), ['11', '22']);
});

test('同库存在重复车牌时不合并，不隐藏脏数据', () => {
  const groups = groupParkingVehicleRows([
    row('parking1', '沪a0a998', '11'),
    row('parking1', '沪a0a998', '12'),
    row('parking2', '沪a0a998', '22'),
  ], (item) => item.plate, (item) => item.id);
  assert.equal(groups.length, 3);
  assert.ok(groups.every((group) => !group.merged));
  assert.ok(groups.every((group) => parkingRenewalTargets(group).length === 1));
});

test('完整车牌查询和新增查重不依赖德立云状态轮询结果', () => {
  const page = readFileSync(new URL('../src/pages/ParkingManagementPage.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /isFullParkingPlate\(queryTerm\)\s*&&\s*deliyun\?\.readEnabled/,
    '状态探测与真实车辆查询必须解耦，不能静默跳过德立云');
  assert.doesNotMatch(page, /deliyun\?\.readEnabled\s*\?\s*accessCardIssuance\.deliyunVehiclesByPlate/,
    '新增查重必须始终调用德立云正式查询接口');
  assert.match(page, /isFullParkingPlate\(queryTerm\)[\s\S]{0,160}deliyunVehiclesByPlate\(queryTerm\)/);
  assert.match(page, /Promise\.all\(\[[\s\S]{0,240}deliyunVehiclesByPlate\(normalizedPlate\)/);
});

test('德立云续期明确只改有效期且写后回读', () => {
  const page = readFileSync(new URL('../src/pages/ParkingManagementPage.tsx', import.meta.url), 'utf8');
  assert.match(page, /只修改有效期，不登记收费/);
  assert.match(page, /renewDeliyunVehicle\(\{/);
  assert.match(page, /previousEndDate: target\.row\.endDate/);
  assert.match(page, /await searchParking\(target\.row\.plate\)/, '写入完成后必须重新查询正式数据');
  assert.match(page, /车位池车辆暂不能在此续期/, '关联车位日期不能冒充普通车辆有效期修改');
});

test('二期人防勾选使用德立云真实授权并在变更后重新查询', () => {
  const page = readFileSync(new URL('../src/pages/ParkingManagementPage.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /key: 'civil'[\s\S]{0,160}authorized: false/,
    '人防授权不得继续硬编码为未勾选');
  assert.match(page, /civilDefenseAuthorized/,
    '本地车辆卡必须合并同车牌的德立云授权结果');
  assert.match(page, /label: '二期人防车库', value: 'civil'/,
    '调整车库授权必须提供人防勾选');
  assert.match(page, /setDeliyunCivilDefenseAuthorization\(\{/,
    '人防授权变化必须调用德立云写入接口');
  assert.match(page, /kind === 'add_vehicle' && requestedGarages\.includes\('civil'\)/,
    '新增车辆选择人防时也必须自动写入德立云');
  assert.match(page, /garages,\s*\n\s*effective:/,
    '新增车辆提交必须保留用户选择的人防车库供德立云写入');
  assert.match(page, /begin: \['stratime', 'sarttime', 'starttime'/,
    '德立云新建车辆的开始日必须兼容旧库 D_Stratime 与历史 Sart_Time 拼写');
  assert.match(page, /await searchParking\(searchedTerm \|\| term\)/,
    '旧库与德立云完成后必须重新查询展示最终状态');
  assert.match(page, /kind === 'update_garages' && row && requestedGarages\.includes\('civil'\)/,
    '新增德立云人防车辆前必须预检旧库现有的开始日和到期日');
  assert.match(page, /onOperation\('update_garages', row, group\.rows\)/,
    '选中旧库缺日期时应能从同车牌的另一旧库读取完整日期');
});

test('到期日只比较日期，房号自增后缀仍识别为同一房号', () => {
  assert.equal(normalizeParkingDate('2027-09-30 23:59:59'), '2027-09-30');
  assert.equal(normalizeParkingRoomIdentity('198/5/102/2'), '198/5/102');
  assert.equal(normalizeParkingRoomIdentity('198-5-102'), '198/5/102');
  assert.equal(sameParkingText('地库91号\r\n操作来源：PMS系统', '地库91号\n操作来源：PMS系统'), true);
});

test('人防建档复用同一旧库车辆的开始和结束日期，缺失时才用另一库', () => {
  assert.deepEqual(firstValidParkingPeriod([
    { beginDate: null, endDate: '2027-09-30' },
    { beginDate: '2026-10-01', endDate: '2027-09-30' },
  ]), { beginDate: '2026-10-01', endDate: '2027-09-30' });
  assert.equal(firstValidParkingPeriod([{ beginDate: '2026-02-31', endDate: '2027-09-30' }]), null);
  assert.equal(firstValidParkingPeriod([{ beginDate: '2027-10-01', endDate: '2027-09-30' }]), null);
});

test('进出记录查询按钮提交日历显示的日期，而非上次已查询日期', () => {
  const page = readFileSync(new URL('../src/pages/ParkingManagementPage.tsx', import.meta.url), 'utf8');
  const movement = page.slice(page.indexOf('function ParkingMovementSection('), page.indexOf('function ParkingOperationModal('));
  assert.match(movement, /value=\{pickerRange\}/, '日期控件须显示临时选择，而非仅显示已提交的查询范围');
  assert.match(movement, /onCalendarChange=\{\(dates\) => setPickerRange\(dates\)\}/, '选第一天时须立即保存日历的临时状态');
  assert.match(movement, /const start = pickerRange\[0\]\.format\('YYYY-MM-DD'\)/);
  assert.match(movement, /const end = pickerRange\[1\]\.format\('YYYY-MM-DD'\)/);
  assert.match(movement, /setRange\(\[start, end\]\)/, '按日期查询必须提交日历显示的范围');
  assert.match(movement, /本次查询：\{range\[0\]\} 至 \{range\[1\]\}/, '结果旁应显示实际已查询的范围');
});

test('金额报表明细按类别分页而不是最近30条截断', () => {
  const report = readFileSync(new URL('../src/pages/ReportsPage.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(report, /最近\s*30\s*条流水|最近30条明细/);
  assert.match(report, /岗亭出场应收收费清单/);
  assert.match(report, /月租车续期收费清单/);
  assert.match(report, /parking\/fees\/details\/queries/);
  const fees = report.slice(report.indexOf('function ParkingFeesReport()'), report.indexOf('function ParkingFeeDetailTable('));
  assert.match(fees, /value=\{pickerRange\}/);
  assert.match(fees, /onCalendarChange=\{\(dates\) => setPickerRange\(dates\)\}/);
  assert.match(fees, /const startDate = pickerRange\[0\]/);
});
