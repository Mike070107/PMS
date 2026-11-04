import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {TARGETS,ROOT} from './release-check.mjs';
import {join} from 'node:path';
test('正式Web目标包含新版源码，避免后续发布退回旧首页',()=>{assert.ok(TARGETS.web.paths.includes('apps/neighbor-web'))});
test('正式Web构建新版并明确根路径和正式版本',()=>{const s=readFileSync(join(ROOT,'deploy/publish-production.ps1'),'utf8');assert.match(s,/pnpm --filter '@pms\/neighbor-web' build/);assert.match(s,/VITE_BASE = '\/'/);assert.match(s,/VITE_APP_VERSION = "2\.0\./);assert.match(s,/apps\\neighbor-web\\dist/)});
