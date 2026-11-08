/**
 * 小程序页面访问上报（员工端 / 业主端共用）。
 *
 * 为什么要包一层全局 Page：微信小程序没有官方的「路由变化」监听（wx.onAppRoute 不存在于
 * 官方基础库），而逐个页面改 onShow 属于动业务代码。这里在 app.ts 启动早期替换全局 Page，
 * 给每个页面的 onShow 挂一次上报，页面代码本身零改动。
 *
 * 口径：
 * - 只上报页面路径，不拼参数/查询串（防敏感信息进统计）：页面 pages/pool/pool → /miniapp-staff/pool
 * - 登录页不上报；没有 token 时静默丢弃（未登录不上报）
 * - 批量：满 20 条或 30 秒发一次；App.onHide（切后台）时立即 flush
 * - 发送失败/401 只丢弃，不提示用户、不重试（统计是旁路，不能影响业务）
 * - 同一路径 1 秒内只记一次，避免框架重复触发 onShow 造成重复计数
 *
 * 本包不引入小程序全局类型（同 autoUpdate.ts / speech.ts），只声明用到的这几个 API。
 */
declare let Page: any;
declare function setTimeout(handler: () => void, timeout?: number): number;
declare function clearTimeout(handle?: number): void;

export type PageViewSource = 'miniapp-staff' | 'miniapp-owner';

export interface PageViewRecord {
  /** 归一后的统计路径，如 /miniapp-staff/pool */
  path: string;
  source: PageViewSource;
  pageKey?: string;
}

export interface PageTelemetryOptions {
  source: PageViewSource;
  /** 路径前缀（不带 /），如 miniapp-staff */
  prefix: string;
  /** 当前是否登录（无 token 时不上报） */
  hasToken: () => boolean;
  /** 实际上报动作：由各端 app.ts 注入 api-client 的 request，避免共享包依赖小程序请求实现 */
  send: (views: PageViewRecord[]) => Promise<unknown> | void;
  /** 满多少条立即上报，默认 20 */
  batchSize?: number;
  /** 定时上报间隔，默认 30 秒 */
  intervalMs?: number;
}

const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_INTERVAL_MS = 30_000;
/** 同一路径的重复 onShow 去重窗口 */
const SAME_PATH_DEDUPE_MS = 1000;

let options: Required<Pick<PageTelemetryOptions, 'source' | 'prefix' | 'hasToken' | 'send' | 'batchSize' | 'intervalMs'>> | null = null;
let buffer: PageViewRecord[] = [];
let timer: number | null = null;
let sending = false;
let installed = false;
let lastPath = '';
let lastRecordAt = 0;

/**
 * 页面路由 → 统计路径：去掉 pages/ 前缀与 query，折叠「目录/同名页面」，
 * 登录页返回 null（不统计）。
 * pages/pool/pool → /miniapp-staff/pool
 * pages/order-detail/order-detail → /miniapp-staff/order-detail
 */
export function normalizePageRoute(route: string, prefix: string): string | null {
  const raw = String(route || '').trim().split(/[?#]/)[0].replace(/^\/+/, '');
  if (!raw) return null;
  const parts = raw.split('/').filter(Boolean);
  if (parts[0] === 'pages') parts.shift();
  while (parts.length > 1 && parts[parts.length - 1] === parts[parts.length - 2]) parts.pop();
  const short = parts.join('/');
  if (!short || short === 'login') return null;
  const cleanPrefix = String(prefix || '').replace(/^\/+|\/+$/g, '');
  const path = `/${cleanPrefix}/${short}`;
  return path.length > 300 ? path.slice(0, 300) : path;
}

/** 在 app.ts 顶层调用一次；之后再注册的页面 onShow 都会自动上报。 */
export function installPageTelemetry(input: PageTelemetryOptions): void {
  if (installed) return;
  installed = true;
  options = {
    source: input.source,
    prefix: String(input.prefix || input.source).replace(/^\/+|\/+$/g, ''),
    hasToken: input.hasToken,
    send: input.send,
    batchSize: Math.max(1, Number(input.batchSize) || DEFAULT_BATCH_SIZE),
    intervalMs: Math.max(1000, Number(input.intervalMs) || DEFAULT_INTERVAL_MS),
  };
  const originalPage: any = Page;
  if (typeof originalPage !== 'function') return;
  try {
    // 极少数基础库可能把 Page 定义成只读全局；替换失败就放弃统计，绝不能让小程序启动崩掉。
    Page = function pageTelemetryWrapper(pageOptions: any) {
      try {
        if (pageOptions && typeof pageOptions === 'object') {
          const originalShow = pageOptions.onShow;
          pageOptions.onShow = function pageTelemetryOnShow(this: any, ...args: any[]) {
            try {
              const page = this && (this.route || this.__route__);
              recordPageView(String(page || ''));
            } catch {
              // 埋点失败绝不能影响页面展示
            }
            if (typeof originalShow === 'function') return originalShow.apply(this, args);
            return undefined;
          };
        }
      } catch {
        // 页面选项异常时保持原样注册
      }
      return originalPage(pageOptions);
    };
  } catch {
    // 替换失败：只影响统计，不影响业务
  }
}

/** 切后台时立即发送缓冲；也可在需要的地方手动调用。 */
export function flushPageTelemetry(): void {
  void flush();
}

/** 生产环境用不到，测试可以拿它确认状态清空逻辑。 */
export function pendingPageViewCount(): number {
  return buffer.length;
}

function recordPageView(route: string): void {
  const config = options;
  if (!config || !route) return;
  try {
    if (!config.hasToken()) return;
  } catch {
    return;
  }
  const path = normalizePageRoute(route, config.prefix);
  if (!path) return;
  const now = Date.now();
  if (path === lastPath && now - lastRecordAt < SAME_PATH_DEDUPE_MS) return;
  lastPath = path;
  lastRecordAt = now;
  buffer.push({ path, source: config.source });
  if (buffer.length >= config.batchSize) {
    void flush();
    return;
  }
  schedule();
}

function schedule(): void {
  if (timer !== null || !options || !buffer.length) return;
  timer = setTimeout(() => {
    timer = null;
    void flush();
  }, options.intervalMs);
}

function clearScheduled(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

async function flush(): Promise<void> {
  const config = options;
  if (!config || sending) return;
  clearScheduled();
  if (!buffer.length) return;
  let loggedIn = false;
  try {
    loggedIn = config.hasToken();
  } catch {
    loggedIn = false;
  }
  if (!loggedIn) {
    // 未登录（或已退出）时丢弃缓冲，避免把旧会话的访问记到下一个账号头上
    buffer = [];
    return;
  }
  const views = buffer.splice(0, buffer.length);
  sending = true;
  try {
    await config.send(views);
  } catch {
    // 发送失败/401 静默丢弃：统计是旁路，不提示用户、不重试
  } finally {
    sending = false;
    if (buffer.length) {
      if (buffer.length >= config.batchSize) void flush();
      else schedule();
    }
  }
}
