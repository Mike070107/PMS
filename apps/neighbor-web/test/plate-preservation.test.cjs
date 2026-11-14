const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = p => fs.readFileSync(path.resolve(__dirname, '../../..', p), 'utf8');
test('new plate sheet submits identifiers only, never normalized/default identity', () => {
  const change = read('apps/neighbor-web/src/components/vehicle-ops/PlateChangeSheet.tsx');
  assert.doesNotMatch(change, /passthroughFields|identity:|carType:|endDate:|ownerName:/);
});
test('legacy plate form cannot edit classification', () => {
  const source = read('apps/admin-web/src/pages/ParkingManagementPage.tsx');
  assert.match(source, /runPreservedParkingOperation/);
  assert.match(source, /if \(kind === 'change_plate'\)\s*\{\s*onSubmit\(\{ plate, newPlate \}\)/);
});
test('agent plate branch must use transactionally preserved source, not payload defaults', () => {
  const source = read('tools/access-card-agent/ParkingDatabase.cs');
  const branch = source.slice(source.indexOf('if (task.kind == "change_plate")'), source.indexOf('if (task.kind == "delete_vehicle")'));
  assert.doesNotMatch(branch, /Number\(payload, "carType"|Value\(payload, "identity"/);
  assert.match(branch, /ChangePlatePreservingVehicle/);
});
