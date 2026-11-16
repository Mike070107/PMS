import { build } from '../../apps/admin-web/node_modules/vite/dist/node/index.js';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = process.cwd();
const out = path.resolve(root, 'outputs/repair-intake-timeline-20261116');
const frozen = JSON.parse(fs.readFileSync(path.join(out, 'source-freeze.json'), 'utf8'));
process.env.VITE_BUILD_COMMIT = frozen.head;
const results = [];
for (const app of ['admin-web', 'neighbor-web']) {
  let sharedModule; let timelineModule;
  const outDir = path.resolve(out, 'build-' + app);
  assert.equal(path.dirname(outDir), out);
  console.log(`Build ${app}; artifacts only: ${outDir}`);
  // Reuse the previously verified esbuild service-protocol fallback: a fresh,
  // intentionally absent TEMP avoids its broken Windows >1MiB file transport.
  // No ACL/dependency patching and no changes to target or default minification.
  const pipeTemp = path.join(out, `nonexistent-vite-pipe-${process.pid}-${app}`);
  assert.equal(fs.existsSync(pipeTemp), false);
  process.env.TEMP = process.env.TMP = pipeTemp;
  console.log(`VITE_PROCESS_PIPE_TEMP=${pipeTemp}`);
  await build({
    root: path.resolve(root, 'apps', app),
    configFile: path.resolve(root, 'apps', app, 'vite.config.ts'),
    // The admin app's scratch node_modules points outside this worktree. Pin source
    // aliases for this verification only; never edit that shared dependency tree.
    resolve: { alias: {
      '@pms/shared-types': path.resolve(root, 'packages/shared-types/src'),
      '@pms/api-client': path.resolve(root, 'packages/api-client/src'),
    } },
    build: { outDir, emptyOutDir: false },
    plugins: [{ name: 'verify-address-source', generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue;
        for (const [id, info] of Object.entries(chunk.modules)) {
          if (id.replace(/\\/g, '/').endsWith('/packages/shared-types/src/timeline.ts') && info.renderedExports.includes('sortTimelineNewestFirst')) { assert.equal(path.resolve(id), path.resolve(root, 'packages/shared-types/src/timeline.ts')); timelineModule = { source: id, chunk: chunk.fileName, renderedExports: info.renderedExports }; }
          if (id.replace(/\\/g, '/').endsWith('/packages/shared-types/src/address.ts') && info.renderedExports.includes('dedupeAddressText')) {
            assert.equal(path.resolve(id), path.resolve(root, 'packages/shared-types/src/address.ts'));
            sharedModule = { source: id, chunk: chunk.fileName, renderedExports: info.renderedExports };
          }
        }
      }
    } }],
  });
  assert.ok(timelineModule, 'Must render actual latest-first helper from this worktree');
  assert.ok(sharedModule, 'Must render actual dedupeAddressText from this frozen worktree');
  assert.equal(fs.existsSync(pipeTemp), false, 'Protocol fallback must not create temporary transport directory');
  results.push({ app, sourceCommit: frozen.head, localOnly: true, defaultMinifyAndTargetUnchanged: true, pipeTempRemainsAbsent: true, sharedModule, timelineModule });
}
fs.writeFileSync(path.join(out, 'web-build-proof.json'), JSON.stringify(results, null, 2) + '\n');
console.log('PASS: both Web builds use dedupeAddressText from this exact worktree; no server started or production deployed.');
