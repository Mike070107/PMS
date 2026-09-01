/**
 * 「后端返回的这坨东西，是响应包装还是业务对象？」—— 判断口径的唯一出处。
 *
 * **只看「有没有 code 字段」会把业务对象当成错误响应。**
 * 材料 SKU 的编码字段就叫 `code`（'WJ-0010'）：保存后接口返回的就是这条材料，
 * 老逻辑一看 `code !== 0` 就抛「请求失败」，而库里其实已经写进去了 ——
 * 用户点保存看到红字报错、以为没存上，反复点（2026-09-01 实际遇到）。
 * 同样带 `code` 字段的还有字典项 dict_items、定额项 quota_items，
 * 它们的保存以前也是一样的下场，改这一处就一起好了。
 *
 * 要三条同时成立才当包装：code 是**数字**、不是数组、并且带 data 或 message。
 * 本项目的 API 实际上全是裸返回、用 HTTP 状态码表达错误（后端零处返回 code 包装），
 * 这段只是留给包装格式的兼容路径，宁可判得严一点。
 *
 * 单独一个文件是为了能被 node --test 直接跑：request.ts 里有 fetch / Response，
 * 在 api 那份 tsconfig 下编译不过，测试挂不上去。
 */
export function isApiEnvelope(raw: any): boolean {
  return (
    !!raw &&
    typeof raw === 'object' &&
    !Array.isArray(raw) &&
    typeof raw.code === 'number' &&
    ('data' in raw || 'message' in raw)
  );
}
