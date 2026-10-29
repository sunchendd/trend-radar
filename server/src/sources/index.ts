import type { AppConfig } from '../config.js';
import type { Source, SourceError } from '../types.js';
import { parseArxivAtom } from './arxiv.js';
import { DEFAULT_SOURCES } from './defaults.js';
import { parseFeed } from './feed.js';
import type { RawItem } from './raw.js';

/**
 * 多源抓取调度。
 *
 * 三个硬性约束决定了这里的结构：
 * 1. **单源失败不能中断整轮**：每个源独立 try/catch，错误收集进 SourceError[]，
 *    因为只要有一个厂商 blog 挂掉就把整轮采集判失败，雷达就彻底不可用了。
 * 2. **同一 URL 只发一次请求**：arXiv export 接口并发打同一个 URL 会 500，
 *    而且多个源可能共享同一地址，所以做请求级 Promise 缓存（同 URL 共享同一次响应）。
 * 3. **fetch 必须可注入**：测试要用假 fetcher，任何真实网络调用都是测试缺陷。
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface FetchDeps {
  /** 注入的 fetch；默认用全局 fetch */
  fetch?: FetchLike;
  /** 源清单（默认内置清单；collect 传数据库里的 enabled 源） */
  sources?: readonly Source[];
  /** 单源保留上限，默认 config.limitPerSource */
  limitPerSource?: number;
  /** 并发上限，默认 6 */
  concurrency?: number;
  /** 单请求超时，默认 20s */
  timeoutMs?: number;
  /**
   * 按 host 覆盖超时。arXiv 的 max_results=20 查询实测有 16s 长尾（还会偶发 20s+），
   * 20s 的通用超时会误杀本领域最重要的源，所以单独放给 30s。
   */
  hostTimeoutsMs?: Record<string, number>;
  /** 同 host 请求的最小间隔（毫秒），默认 arXiv 3s：官方要求，实测并发会直接断连（curl http=000） */
  hostPacingMs?: Record<string, number>;
  /** 单 URL 的最大尝试次数，默认 2（第二次是退避重试） */
  attempts?: number;
  /** 时间源，测试注入固定时间用 */
  now?: () => Date;
}

/** 单源抓取耗时诊断。刻意不进 types.ts（契约冻结），只给 CLI / 运行日志用 */
export interface SourceTiming {
  sourceId: string;
  /** 毫秒；含等待同 host 限速闸门与共享请求的时间 */
  ms: number;
  /** 该源本轮保留的条目数 */
  items: number;
  error?: string;
}

export interface FetchAllResult {
  /** 原始条目（未去重、未打分） */
  items: RawItem[];
  errors: SourceError[];
  /** 抓到的原始条目数 */
  fetched: number;
  /** 实际参与的源数量 */
  sourceCount: number;
  /** 每源耗时，按 sourceId 排序 */
  timings: SourceTiming[];
}

const DEFAULT_CONCURRENCY = 6;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_ATTEMPTS = 2;
/** arXiv 长尾实测 16s，20s 会误杀；其余源仍按 20s */
const DEFAULT_HOST_TIMEOUTS: Record<string, number> = { 'export.arxiv.org': 30_000 };
const USER_AGENT = 'trend-radar/0.1 (technical-intelligence-radar; +https://github.com/trend-radar)';
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** 同 host 限速闸门：串行放行，保证相邻两次请求的发出时间至少间隔 minGapMs */
function createGate(minGapMs: number): () => Promise<void> {
  let tail: Promise<void> = Promise.resolve();
  let lastAt = 0;

  return async () => {
    const previous = tail;
    let release: () => void = () => {};
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;

    const wait = minGapMs - (Date.now() - lastAt);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastAt = Date.now();
    release();
  };
}

/** 简单并发池：不引入 p-limit，行为足够可预测，也不需要新依赖 */
async function runPool<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array<T>(tasks.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const task = tasks[index];
      if (!task) return;
      results[index] = await task();
    }
  };

  const size = Math.max(1, Math.min(limit, tasks.length));
  await Promise.all(Array.from({ length: size }, () => worker()));
  return results;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** AbortSignal.timeout 抛的是 TimeoutError（DOMException），不同运行时 name 略有差异，两种都认 */
function isTimeoutError(error: unknown): boolean {
  const name = error instanceof Error ? error.name : (error as { name?: string } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export async function fetchAllSources(
  config: Pick<AppConfig, 'limitPerSource'>,
  deps: FetchDeps = {},
): Promise<FetchAllResult> {
  const fetchImpl: FetchLike = deps.fetch ?? ((input, init) => fetch(input, init));
  const now = deps.now ?? (() => new Date());
  const timeoutMs = Math.max(1, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const attempts = Math.max(1, deps.attempts ?? DEFAULT_ATTEMPTS);
  const limitPerSource = Math.max(1, deps.limitPerSource ?? config.limitPerSource);
  const concurrency = Math.max(1, deps.concurrency ?? DEFAULT_CONCURRENCY);
  const pacing: Record<string, number> = deps.hostPacingMs ?? { 'export.arxiv.org': 3000 };
  const hostTimeouts: Record<string, number> = deps.hostTimeoutsMs ?? DEFAULT_HOST_TIMEOUTS;

  const enabled = (deps.sources ?? DEFAULT_SOURCES).filter((source) => source.enabled);

  const gates = new Map<string, () => Promise<void>>();
  const gateFor = (url: string): (() => Promise<void>) | undefined => {
    const host = hostOf(url);
    const minGap = pacing[host];
    if (!host || !minGap || minGap <= 0) return undefined;
    let gate = gates.get(host);
    if (!gate) {
      gate = createGate(minGap);
      gates.set(host, gate);
    }
    return gate;
  };

  const timeoutFor = (url: string): number => hostTimeouts[hostOf(url)] ?? timeoutMs;

  const requestText = async (url: string): Promise<string> => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await gateFor(url)?.();
        const response = await fetchImpl(url, {
          signal: AbortSignal.timeout(timeoutFor(url)),
          redirect: 'follow',
          headers: {
            'user-agent': USER_AGENT,
            accept: 'application/atom+xml, application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
          },
        });
        if (!response.ok) {
          if (RETRYABLE_STATUS.has(response.status) && attempt < attempts) {
            lastError = new Error(`HTTP ${response.status}`);
            // 429/503 常常带 Retry-After，照着等比盲等更礼貌也更有效；封顶 5s 免得采集卡死
            const retryAfter = Number(response.headers.get('retry-after'));
            const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(5000, retryAfter * 1000) : 600 * attempt;
            await sleep(wait);
            continue;
          }
          throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
        }
        return await response.text();
      } catch (error) {
        lastError = error;
        // 超时说明源已经挂了，再等 20s 重试只会把整轮采集拖长一倍（HTTP 层是同步等结果的）
        if (isTimeoutError(error)) break;
        if (attempt >= attempts) break;
        // 网络层失败在 arXiv 上常是「请求发太密被掐断」，等久一点再试比立刻重试有效
        await sleep(Math.min(5000, 1500 * attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  };

  // 请求级缓存：同一个 URL 无论被几个源引用，都只发一次（arXiv 并发同 URL 会 500）
  const inflight = new Map<string, Promise<string>>();
  const getText = (url: string): Promise<string> => {
    const cached = inflight.get(url);
    if (cached) return cached;
    const promise = requestText(url);
    inflight.set(url, promise);
    // 失败的 promise 不留在缓存里，否则同一轮的第二个引用者会拿到同样的失败（正确），
    // 但下一轮采集会命中失败缓存（错误），所以这里只缓存成功结果
    promise.catch(() => inflight.delete(url));
    return promise;
  };

  const errors: SourceError[] = [];
  const timings: SourceTiming[] = [];
  const fetchedAt = now();

  const tasks = enabled.map((source) => async (): Promise<RawItem[]> => {
    const startMs = performance.now();
    try {
      const body = await getText(source.url);
      const parsed = source.kind === 'arxiv' ? parseArxivAtom(body, source, fetchedAt) : parseFeed(body, source, fetchedAt);
      const items = parsed.slice(0, limitPerSource);
      timings.push({ sourceId: source.id, ms: Math.round(performance.now() - startMs), items: items.length });
      return items;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ sourceId: source.id, message });
      // 失败也记耗时：慢源和坏源在运行日志里要能区分开
      timings.push({ sourceId: source.id, ms: Math.round(performance.now() - startMs), items: 0, error: message });
      return [];
    }
  });

  const perSource = await runPool(tasks, concurrency);
  const items = perSource.flat();

  return {
    items,
    errors,
    fetched: items.length,
    sourceCount: enabled.length,
    timings: timings.sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
  };
}
