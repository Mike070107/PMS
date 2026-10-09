import assert from 'node:assert/strict';
import test from 'node:test';
import { createUploadPasteTargetRegistry } from '../src/components/useUploadPasteTarget.ts';

test('同页多个照片上传区只激活最后选中的粘贴目标', () => {
  const registry = createUploadPasteTargetRegistry();
  let changes = 0;
  const unsubscribe = registry.subscribe(() => { changes += 1; });

  registry.activate('material-1');
  assert.equal(registry.getActive(), 'material-1');

  registry.activate('material-2');
  assert.equal(registry.getActive(), 'material-2');

  registry.release('material-1');
  assert.equal(registry.getActive(), 'material-2');

  registry.release('material-2');
  assert.equal(registry.getActive(), null);
  assert.equal(changes, 3);
  unsubscribe();
});
