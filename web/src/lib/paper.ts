/**
 * 论文阅读器的 API 客户端与类型（与 server/src/store/papers.ts 同步）。
 *
 * 阅读器不进「演示模式」：没有真实后端时整个阅读器无从谈起，
 * 所有请求失败都如实抛 ApiError，由阅读器 UI 展示可重试状态。
 */
import { ApiError, toApiError } from './api';

// ---------------------------------------------------------------- 类型

export type PaperStatus = 'none' | 'pending' | 'ready' | 'failed';

export interface PaperInfo {
  itemId: string;
  status: PaperStatus;
  originUrl: string;
  bytes: number | null;
  error: string;
  downloadedAt: string | null;
  updatedAt: string;
}

export interface PaperRect {
  /** 0–1，归一化到页面尺寸，随缩放不变 */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PaperAnnotation {
  id: string;
  itemId: string;
  /** 1 起的页码 */
  page: number;
  rects: PaperRect[];
  text: string;
  note: string;
  color: string;
  createdAt: string;
  updatedAt: string;
}

/** 与 server 端 ANNOTATION_COLORS 保持一致 */
export const ANNOTATION_COLORS = ['#f2b357', '#35e7c5', '#7aa7f7', '#ff8fa3', '#c3a6ff'] as const;
export type AnnotationColor = (typeof ANNOTATION_COLORS)[number];

// ---------------------------------------------------------------- 下载与状态

export function getPaperStatus(itemId: string): Promise<PaperInfo> {
  return plainRequest(`/api/items/${encodeURIComponent(itemId)}/paper`);
}

/** 触发下载（幂等）；服务端在飞期间重复请求会复用同一个下载 */
export function downloadPaper(itemId: string): Promise<PaperInfo> {
  return plainRequest(`/api/items/${encodeURIComponent(itemId)}/paper`, { method: 'POST', timeout: 90_000 });
}

export function paperFileUrl(itemId: string): string {
  return `/api/items/${encodeURIComponent(itemId)}/paper/file`;
}

// ---------------------------------------------------------------- 标注

export function listAnnotations(itemId: string): Promise<PaperAnnotation[]> {
  return plainRequest(`/api/items/${encodeURIComponent(itemId)}/annotations`);
}

export function addAnnotation(
  itemId: string,
  input: { page: number; rects: PaperRect[]; text?: string; note?: string; color?: AnnotationColor },
): Promise<PaperAnnotation> {
  return plainRequest(`/api/items/${encodeURIComponent(itemId)}/annotations`, { method: 'POST', body: input });
}

export function updateAnnotation(
  itemId: string,
  annotationId: string,
  patch: { note?: string; color?: AnnotationColor },
): Promise<PaperAnnotation> {
  return plainRequest(`/api/items/${encodeURIComponent(itemId)}/annotations/${encodeURIComponent(annotationId)}`, {
    method: 'PATCH',
    body: patch,
  });
}

export function removeAnnotation(itemId: string, annotationId: string): Promise<void> {
  return plainRequest(`/api/items/${encodeURIComponent(itemId)}/annotations/${encodeURIComponent(annotationId)}`, {
    method: 'DELETE',
  });
}

// ---------------------------------------------------------------- 选中文本提问（SSE）

export interface PaperAskMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface PaperAskContext {
  page: number;
  /** 当前页文本（pdf.js 文本层提取） */
  pageText: string;
  /** 用户选中的文本；空串 = 针对整页提问 */
  selection: string;
}

export interface PaperAskOptions {
  itemId: string;
  question: string;
  context: PaperAskContext;
  history: PaperAskMessage[];
}

export interface PaperAskCallbacks {
  onStatus?: (label: string) => void;
  onToken?: (text: string) => void;
  onDone?: () => void;
  onError?: (code: string, message: string) => void;
}

/**
 * 选中文本提问：POST + SSE（帧契约与 /api/chat 相同）。
 * 非流式错误（校验失败 / 503 / 429）抛 ApiError；流内 error 事件回调 onError。
 */
export async function streamPaperAsk(
  opts: PaperAskOptions,
  callbacks: PaperAskCallbacks,
  signal: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`/api/items/${encodeURIComponent(opts.itemId)}/paper/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: opts.question,
        page: opts.context.page,
        pageText: opts.context.pageText,
        selection: opts.context.selection,
        ...(opts.history.length > 0 ? { history: opts.history } : {}),
      }),
      signal,
    });
  } catch (err) {
    if (signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
    throw new ApiError('network_error', '无法连接后端：论文提问接口', 0);
  }

  const ctype = (res.headers.get('content-type') ?? '').toLowerCase();
  if (!res.ok || !ctype.includes('text/event-stream')) {
    const text = await res.text().catch(() => '');
    let parsed: unknown = null;
    try {
      parsed = text.trim() === '' ? null : (JSON.parse(text) as unknown);
    } catch {
      parsed = null;
    }
    if (typeof parsed === 'object' && parsed !== null && 'error' in (parsed as Record<string, unknown>)) {
      const boxed = (parsed as { error?: { code?: unknown; message?: unknown } }).error;
      if (typeof boxed === 'object' && boxed !== null) {
        throw new ApiError(
          boxed.code === 'llm_not_configured' ? 'llm_not_configured' : res.status === 429 ? 'unknown' : 'unknown',
          typeof boxed.message === 'string' ? boxed.message : `HTTP ${res.status}`,
          res.status,
        );
      }
    }
    throw new ApiError('bad_response', res.status === 429 ? '当前对话并发已达上限，稍后再试' : '论文提问接口没有返回 SSE 流', res.status);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new ApiError('bad_response', '提问响应没有可读流', res.status);

  const decoder = new TextDecoder();
  let buffer = '';
  let finished = false;

  const handleFrame = (frame: string): void => {
    if (finished) return;
    let event = '';
    const dataLines: string[] = [];
    for (const line of frame.split('\n')) {
      if (line === '' || line.startsWith(':')) continue;
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    if (dataLines.length === 0) return;
    let data: unknown;
    try {
      data = JSON.parse(dataLines.join('\n')) as unknown;
    } catch {
      return; // 半截 JSON：丢帧不中断
    }
    if (typeof data !== 'object' || data === null) return;
    const o = data as Record<string, unknown>;
    switch (event) {
      case 'status':
        if (typeof o.label === 'string') callbacks.onStatus?.(o.label);
        break;
      case 'token':
        if (typeof o.text === 'string' && o.text !== '') callbacks.onToken?.(o.text);
        break;
      case 'done':
        finished = true;
        callbacks.onDone?.();
        break;
      case 'error':
        finished = true;
        callbacks.onError?.(typeof o.code === 'string' ? o.code : 'unknown', typeof o.message === 'string' ? o.message : '生成失败');
        break;
      default:
        break;
    }
  };

  try {
    while (!finished) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx = buffer.indexOf('\n\n');
      while (idx >= 0) {
        handleFrame(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 2);
        if (finished) break;
        idx = buffer.indexOf('\n\n');
      }
    }
    if (!finished && buffer.trim().length > 0) handleFrame(buffer);
  } catch (err) {
    if (signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
    try {
      await reader.cancel();
    } catch {
      // 连接已断，忽略
    }
    throw new ApiError('network_error', '连接中断，已停止生成', 0);
  }
}

// ---------------------------------------------------------------- 底层请求

interface PlainOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  timeout?: number;
}

async function plainRequest<T>(path: string, opts: PlainOptions = {}): Promise<T> {
  const timeout = opts.timeout ?? 12_000;
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
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ApiError('timeout', `请求超时：${path}`, 0);
    }
    throw new ApiError('network_error', `无法连接后端：${path}`, 0);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let parsed: unknown = null;
  if (text.trim() !== '') {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = null;
    }
  }
  if (!res.ok) {
    if (typeof parsed === 'object' && parsed !== null && 'error' in (parsed as Record<string, unknown>)) {
      const boxed = (parsed as { error?: { code?: unknown; message?: unknown } }).error;
      if (typeof boxed === 'object' && boxed !== null) {
        throw new ApiError(
          boxed.code === 'llm_not_configured' ? 'llm_not_configured' : 'unknown',
          typeof boxed.message === 'string' ? boxed.message : `HTTP ${res.status}`,
          res.status,
        );
      }
    }
    throw toApiError(new Error(`HTTP ${res.status}：${path}`));
  }
  return parsed as T;
}
