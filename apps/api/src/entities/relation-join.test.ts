import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getMetadataArgsStorage } from 'typeorm';
import './index';

/**
 * 锁住 2026-09-15 的线上事故：后台「房产管理 → 删除」一律 Internal server error。
 *
 * 根因是一行 `.leftJoin('w.request', 'r')`：WorkOrder 上的 request_id 只是普通列，
 * 没有声明 @ManyToOne 关系，TypeORM **拼查询时**就抛
 * 「Relation with property path request in entity was not found」。
 *
 * 为什么必须用测试守：这类错 `tsc --noEmit` 和 `nest build` 一个都发现不了
 * （字符串里的东西），只有真正调到那个接口才炸 —— 而删除房产平时没人点，
 * 它就这么在线上躺着。
 *
 * 做法：扫源码里所有「按关系路径 join」的写法（`join('别名.属性')`），
 * 要求这个属性确实是某个实体上声明过的关系。实体的关系表由装饰器在 import 时
 * 注册进 getMetadataArgsStorage()，**不需要连数据库**。
 * 全仓目前一个这样的写法都不该有（其余查询一律显式 join 表），
 * 新增时只要属性真的声明了关系就照样通过。
 */

const API_SRC = join(__dirname, '..');
const JOIN_RE =
  /\.(?:leftJoin|innerJoin|leftJoinAndSelect|innerJoinAndSelect)\(\s*'([A-Za-z_$][\w$]*)\.([\w$]+)'/g;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === 'dist') continue;
      out.push(...walk(full));
      continue;
    }
    if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

test('按关系路径 join 的属性必须真的是实体上声明过的关系', () => {
  const declared = new Set(
    getMetadataArgsStorage().relations.map((item) => item.propertyName),
  );
  // 关系表是靠装饰器注册的：一个都没有就说明实体没被 import 进来，测试等于没跑
  assert.ok(declared.size > 0, '实体关系表是空的，检查 ./index 的导入');

  const offenders: string[] = [];
  for (const file of walk(API_SRC)) {
    if (file.endsWith('relation-join.test.ts')) continue;
    const text = readFileSync(file, 'utf8');
    JOIN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = JOIN_RE.exec(text))) {
      const [, alias, prop] = m;
      if (declared.has(prop)) continue;
      const line = text.slice(0, m.index).split('\n').length;
      offenders.push(
        `${file.replace(API_SRC, 'src')}:${line} join('${alias}.${prop}')` +
          ` —— 没有任何实体声明过名为 ${prop} 的关系，这一句会在运行时抛` +
          ` Relation with property path ${prop} in entity was not found；` +
          ` 改成按表显式 join（innerJoin(实体, '别名', '条件')）`,
      );
    }
  }
  assert.deepEqual(offenders, [], `\n${offenders.join('\n')}\n`);
});
