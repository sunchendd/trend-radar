/**
 * 唯一允许发 HTTP 的地方。
 *
 * 约定：
 * 1. 所有请求带超时（AbortController），错误统一映射成 ApiError；
 * 2. 演示数据只在 `import.meta.env.DEV` **且**请求根本没连上后端时才兜底，
 *    并且会进入全局「演示模式」——界面右上角必须显示徽标，绝不静默假装真数据；
 * 3. 生产构建里没有任何兜底分支，连不上就是错误态。
 */
import type {
  GenerateIdeasRequest,
  IdeaWithVerdict,
  IdeaClusterSummary,
  IdeaStatus,
  Item,
  ItemQuery,
  Paged,
  RunRecord,
  Source,
  Stats,
  SweepResult,
  Watch,
} from './types';
import * as mock from './mock';

// ------------------------------------------------------------------ 错误

export type ApiErrorCode =
  | 'network_error'
  | 'timeout'
  | 'bad_response'
  | 'not_found'
  | 'llm_not_configured'
  | 'novelty_not_configured'
  | 'unknown';

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  /** 0 表示根本没拿到 HTTP 响应（连不上 / 超时） */
  readonly status: number;
  readonly detail: unknown;

  constructor(code: ApiErrorCode, message: string, status = 0, detail: unknown = null) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }

  get offline(): boolean {
    return this.status === 0;
  }
}

/** 把任意异常收敛成 ApiError */
export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof DOMException && err.name === 'AbortError') {
    return new ApiError('timeout', '请求超时', 0);
  }
  if (err instanceof Error) return new ApiError('unknown', err.message, 0);
  return new ApiError('unknown', String(err), 0);
}

export interface FriendlyError {
  title: string;
  hint?: string;
  code: ApiErrorCode;
  offline: boolean;
}

/** 面向用户的可操作错误文案 */
export function friendlyError(err: unknown): FriendlyError {
  const e = toApiError(err);
  if (e.code === 'timeout') {
    return {
      title: '后端响应超时',
      hint: '采集或 LLM 生成可能较慢；检查 `npm run dev:server` 的日志，或稍后重试。',
      code: e.code,
      offline: true,
    };
  }
  if (e.offline) {
    return {
      title: '后端未启动',
      hint: '在仓库根目录运行 `npm run dev:server`（默认 127.0.0.1:8787），本页会自动恢复。',
      code: e.code,
      offline: true,
    };
  }
  if (e.code === 'llm_not_configured') {
    return {
      title: 'LLM 未配置',
      hint: '在 `.env` 里设置 LLM 的 baseURL / apiKey / model 后重启后端，再点「生成选题」。',
      code: e.code,
      offline: false,
    };
  }
  if (e.code === 'novelty_not_configured') {
    return {
      title: '智慧芽 CLI 未配置',
      hint: '自动查新需要智慧芽凭据；也可以先用下方表单手工登记查新记录。',
      code: e.code,
      offline: false,
    };
  }
  return { title: e.message || '请求失败', code: e.code, offline: false };
}

// ------------------------------------------------------------------ 演示模式

let demo = false;
let demoReason = '';
const demoListeners = new Set<() => void>();

export function isDemo(): boolean {
  return demo;
}

export function demoReasonText(): string {
  return demoReason;
}

export function subscribeDemo(cb: () => void): () => void {
  demoListeners.add(cb);
  return () => {
    demoListeners.delete(cb);
  };
}

function enterDemo(reason: string): void {
  if (demo) return;
  demo = true;
  demoReason = reason;
  for (const cb of demoListeners) cb();
}

// ------------------------------------------------------------------ 底层请求

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  timeout?: number;
  /** 仅 DEV 生效；请求没连上后端时用它兜底并进入演示模式 */
  fallback?: () => unknown;
}

const DEFAULT_TIMEOUT = 10_000;

function isDev(): boolean {
  return import.meta.env.DEV === true;
}

async function rawRequest<T>(path: string, opts: RequestOptions): Promise<T> {
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method ?? 'GET',
      headers: opts.body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: controller.signal,
    });
  } catch (err) {
    // 只有「没拿到响应」才算后端没起；这时才允许兜底
    const apiErr =
      err instanceof DOMException && err.name === 'AbortError'
        ? new ApiError('timeout', `请求超时（${Math.round(timeout / 1000)}s）：${path}`, 0)
        : new ApiError('network_error', `无法连接后端：${path}`, 0);
    if (isDev() && opts.fallback) {
      enterDemo('后端未启动（/api 无响应）');
      return castFallback<T>(opts.fallback, path);
    }
    throw apiErr;
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let parsed: unknown = null;
  let parseFailed = false;
  if (text.trim().length > 0) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parseFailed = true;
    }
  }

  if (!res.ok) {
    // 代理层错误（vite dev server 在目标端口没人监听时返回 500 + 空 body /
    // text/plain）说明后端根本没起来，而不是后端处理失败 —— 这两种要分开对待。
    const hasEnvelope =
      typeof parsed === 'object' && parsed !== null && 'error' in (parsed as Record<string, unknown>);
    const looksOffline = !hasEnvelope && (res.status >= 500 || parseFailed);

    if (looksOffline) {
      if (isDev() && opts.fallback) {
        enterDemo(`后端未启动（/api 返回 HTTP ${res.status}，无 JSON 错误体）`);
        return castFallback<T>(opts.fallback, path);
      }
      throw new ApiError('network_error', `后端未响应（HTTP ${res.status}，无 JSON 错误体）：${path}`, 0);
    }
    throw errorFromBody(parsed, res.status);
  }

  if (parseFailed) {
    // 静态服务器把 /api/* 回落成 index.html（SPA fallback）时，说明后端没接管这个端口
    const isHtml = (res.headers.get('content-type') ?? '').includes('text/html');
    if (isHtml) {
      if (isDev() && opts.fallback) {
        enterDemo('后端未接管 /api（返回了 index.html）');
        return castFallback<T>(opts.fallback, path);
      }
      throw new ApiError('network_error', `后端未接管 /api（返回了 HTML）：${path}`, 0);
    }
    throw new ApiError('bad_response', `响应不是合法 JSON：${path}`, res.status, text.slice(0, 300));
  }
  return parsed as T;
}

function errorFromBody(parsed: unknown, status: number): ApiError {
  if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
    const boxed = (parsed as { error?: unknown }).error;
    if (typeof boxed === 'object' && boxed !== null) {
      const obj = boxed as { code?: unknown; message?: unknown; detail?: unknown };
      const code = typeof obj.code === 'string' ? obj.code : '';
      const message = typeof obj.message === 'string' ? obj.message : `HTTP ${status}`;
      const mapped: ApiErrorCode =
        code === 'llm_not_configured'
          ? 'llm_not_configured'
          : code === 'novelty_not_configured'
            ? 'novelty_not_configured'
            : status === 404
              ? 'not_found'
              : 'unknown';
      return new ApiError(mapped, message, status, obj.detail ?? null);
    }
  }
  return new ApiError(status === 404 ? 'not_found' : 'unknown', `HTTP ${status}`, status);
}

function castFallback<T>(fallback: () => unknown, path: string): T {
  try {
    return fallback() as T;
  } catch (err) {
    throw new ApiError('unknown', `演示数据无法响应 ${path}：${toApiError(err).message}`, 0);
  }
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  // 已经处于演示模式：直接走内存库，避免每次请求都等超时
  if (demo && opts.fallback) {
    return castFallback<T>(opts.fallback, path);
  }
  return rawRequest<T>(path, opts);
}

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

// ------------------------------------------------------------------ 只读

export function getHealth(): Promise<{ ok: boolean; version: string; uptimeSec: number }> {
  return request('/api/health', {
    timeout: 4000,
    fallback: () => ({ ok: true, version: '0.1.0-demo', uptimeSec: 0 }),
  });
}

export function getStats(): Promise<Stats> {
  return request('/api/stats', { fallback: () => mock.mockStats() });
}

export function listItems(query: ItemQuery): Promise<Paged<Item>> {
  return request(
    `/api/items${qs({
      q: query.q,
      sourceId: query.sourceId,
      kind: query.kind,
      minScore: query.minScore,
      since: query.since,
      sort: query.sort,
      limit: query.limit,
      offset: query.offset,
    })}`,
    { fallback: () => mock.mockItems(query) },
  );
}

export function getIdea(id: string): Promise<IdeaWithVerdict> {
  return request(`/api/ideas/${encodeURIComponent(id)}`, {
    fallback: () => {
      const found = mock.mockIdeas().find((i) => i.id === id);
      if (!found) throw new ApiError('not_found', `选题不存在：${id}`, 404);
      return found;
    },
  });
}

export function getItem(id: string): Promise<Item> {
  return request(`/api/items/${encodeURIComponent(id)}`, {
    fallback: () => {
      const found = mock.mockItem(id);
      if (!found) throw new ApiError('not_found', `条目不存在：${id}`, 404);
      return found;
    },
  });
}

export function listSources(): Promise<Source[]> {
  return request('/api/sources', { fallback: () => mock.mockSources() });
}

export function listClusters(status?: IdeaStatus): Promise<IdeaClusterSummary[]> {
  return request(`/api/ideas/clusters${status ? `?status=${status}` : ''}`, { fallback: () => [] });
}

export function listIdeas(status?: IdeaStatus): Promise<IdeaWithVerdict[]> {
  return request(`/api/ideas${qs({ status })}`, { fallback: () => mock.mockIdeas(status) });
}

export function listRuns(): Promise<RunRecord[]> {
  return request('/api/runs', { fallback: () => mock.mockRuns() });
}

// ------------------------------------------------------------------ 写

export function collect(sourceIds?: string[]): Promise<RunRecord> {
  return request('/api/collect', {
    method: 'POST',
    body: sourceIds && sourceIds.length > 0 ? { sourceIds } : {},
    timeout: 30_000,
    fallback: () => mock.mockCollect(sourceIds),
  });
}

export function patchSource(
  id: string,
  patch: { enabled?: boolean; weight?: number; note?: string },
): Promise<Source> {
  return request(`/api/sources/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: patch,
    fallback: () => mock.mockPatchSource(id, patch),
  });
}

export function createSource(body: {
  id: string;
  kind: Source['kind'];
  label: string;
  url: string;
  weight?: number;
  tags?: string[];
  note?: string;
}): Promise<Source> {
  return request('/api/sources', {
    method: 'POST',
    body,
    timeout: 15_000,
    fallback: () => mock.mockCreateSource(body),
  });
}

export function deleteSource(id: string): Promise<void> {
  return request(`/api/sources/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    fallback: () => {
      mock.mockDeleteSource(id);
    },
  });
}

export function generateIdeas(
  req: GenerateIdeasRequest,
): Promise<{ ideas: IdeaWithVerdict[]; usedItems: string[] }> {
  return request('/api/ideas/generate', {
    method: 'POST',
    body: req,
    timeout: 90_000,
    fallback: () => mock.mockGenerateIdeas(req.focus, req.count),
  });
}

export function listWatches(all = false): Promise<Watch[]> {
  return request(`/api/watches${all ? '?all=true' : ''}`, { fallback: () => [] });
}

export function addWatch(query: string, note?: string): Promise<Watch> {
  return request('/api/watches', { method: 'POST', body: { query, ...(note ? { note } : {}) } });
}

export function removeWatch(id: string): Promise<void> {
  return request(`/api/watches/${encodeURIComponent(id)}`, { method: 'DELETE', fallback: () => undefined });
}

export function setWatchEnabled(id: string, enabled: boolean): Promise<Watch> {
  return request(`/api/watches/${encodeURIComponent(id)}`, { method: 'PATCH', body: { enabled } });
}

/** 跑一轮巡检：会真调智慧芽，通常 20–60 秒 */
export function runSweep(): Promise<SweepResult> {
  return request('/api/watches/sweep', { method: 'POST', timeout: 180_000, fallback: () => {
    throw new Error('演示模式下不会真的跑巡检');
  } });
}

export interface ManualIdeaPayload {
  title: string;
  problem: string;
  solution: string;
  effect: string;
  keywords?: string[];
  ipcHints?: string[];
  queries?: string[];
  risks?: string[];
  focus?: string;
}

/** 手工创建选题：LLM 不可用时（或想自己写一条）也能进工作台，与生成结果同一张表 */
export function createIdea(req: ManualIdeaPayload): Promise<IdeaWithVerdict> {
  return request('/api/ideas', { method: 'POST', body: req });
}

export function patchIdea(
  id: string,
  patch: { status?: IdeaStatus; title?: string; problem?: string; solution?: string; effect?: string; queries?: string[]; risks?: string[] },
): Promise<IdeaWithVerdict> {
  return request(`/api/ideas/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: patch,
    fallback: () => mock.mockPatchIdea(id, { status: patch.status, title: patch.title }),
  });
}

export function archiveIdea(id: string): Promise<void> {
  return request(`/api/ideas/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    fallback: () => {
      mock.mockPatchIdea(id, { status: 'archived' });
    },
  });
}

export function addNovelty(
  ideaId: string,
  body: { query: string; hits: number | null; topAssignees?: string; note?: string; site?: 'zhihuiya' | 'manual' | 'other' },
): Promise<IdeaWithVerdict> {
  return request(`/api/ideas/${encodeURIComponent(ideaId)}/novelty`, {
    method: 'POST',
    body,
    timeout: 20_000,
    fallback: () => mock.mockAddNovelty(ideaId, body),
  });
}

export function autoNovelty(ideaId: string, queries?: string[]): Promise<IdeaWithVerdict> {
  return request(`/api/ideas/${encodeURIComponent(ideaId)}/novelty/auto`, {
    method: 'POST',
    body: queries ? { queries } : {},
    timeout: 120_000,
    fallback: () => {
      const idea = mock.mockIdeas().find((i) => i.id === ideaId);
      if (!idea) throw new ApiError('not_found', '选题不存在', 404);
      return idea;
    },
  });
}

export function exportUrl(format: 'csv' | 'json'): string {
  return `/api/export?format=${format}`;
}

// ------------------------------------------------------------------ SSE

export type StreamEvent =
  | { type: 'run'; data: RunRecord }
  | { type: 'items'; data: { added?: number; total?: number } }
  | { type: 'idea'; data: IdeaWithVerdict };

/**
 * 订阅 `/api/events`。返回清理函数——组件卸载时必须调用，否则连接泄漏。
 * SSE 断开会自行重连（EventSource 内建），这里只在终态时回调 offline。
 */
export function subscribeEvents(
  onEvent: (e: StreamEvent) => void,
  onStatus?: (status: 'open' | 'error' | 'closed') => void,
): () => void {
  if (typeof EventSource === 'undefined') {
    onStatus?.('closed');
    return () => {};
  }
  let closed = false;
  let es: EventSource | null = null;
  try {
    es = new EventSource('/api/events');
  } catch {
    onStatus?.('error');
    return () => {};
  }

  const parse = (raw: string): unknown => {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  };

  es.addEventListener('open', () => {
    if (!closed) onStatus?.('open');
  });
  es.addEventListener('error', () => {
    if (!closed) onStatus?.('error');
  });
  es.addEventListener('run', (ev: MessageEvent<string>) => {
    const data = parse(ev.data);
    if (data) onEvent({ type: 'run', data: data as RunRecord });
  });
  es.addEventListener('items', (ev: MessageEvent<string>) => {
    const data = parse(ev.data);
    onEvent({ type: 'items', data: (data ?? {}) as { added?: number; total?: number } });
  });
  es.addEventListener('idea', (ev: MessageEvent<string>) => {
    const data = parse(ev.data);
    if (data) onEvent({ type: 'idea', data: data as IdeaWithVerdict });
  });

  return () => {
    closed = true;
    es?.close();
    es = null;
    onStatus?.('closed');
  };
}
