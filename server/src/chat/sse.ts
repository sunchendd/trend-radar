/**
 * /api/chat 的 SSE writer。为什么这么设计：
 *
 * 写帧的纯函数与「done/error 之后必须闭嘴」的状态机收在 createChatSseWriter 里，
 * 对外的唯一接口是一个 write(chunk) 回调——routes.ts 传 reply.raw.write 进来，
 * 单测传一个数组收集器进来，帧格式 `event: <name>\ndata: <json>\n\n` 就能在
 * 不起 HTTP 服务的情况下精确断言。
 */

import type { ChatSourceItem, ChatStep } from './types.js';

export type ChatSseEventName = 'status' | 'sources' | 'token' | 'done' | 'error';

/** 与 http/sse.ts 的 SSE_HEADERS 同口径；单独一份是因为 chat 不经过 hub */
export const CHAT_SSE_HEADERS: Record<string, string> = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
};

/** 单帧格式。JSON.stringify 会把换行转义掉，data 一定单行 */
export const chatFrame = (event: ChatSseEventName, data: unknown): string =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export interface ChatSseWriter {
  status(step: ChatStep, label: string): void;
  /** 覆盖式全量：每次都发当前完整证据列表 */
  sources(items: ChatSourceItem[]): void;
  token(text: string): void;
  /** 收尾帧：恰好发一次，之后任何写入都被忽略 */
  done(payload: { messageId: string; toolsUsed: string[] }): void;
  /** 中途失败：发一帧后闭嘴，由调用方负责关闭连接 */
  error(code: string, message: string): void;
  readonly closed: boolean;
}

export function createChatSseWriter(write: (chunk: string) => void): ChatSseWriter {
  let closed = false;
  const send = (event: ChatSseEventName, data: unknown): void => {
    if (closed) return;
    try {
      write(chatFrame(event, data));
    } catch {
      // 底层 socket 已坏：置为关闭，后续写入全部短路
      closed = true;
    }
  };
  return {
    status: (step, label) => send('status', { step, label }),
    sources: (items) => send('sources', { items }),
    token: (text) => send('token', { text }),
    get closed() {
      return closed;
    },
    done: (payload) => {
      if (closed) return;
      send('done', payload);
      closed = true;
    },
    error: (code, message) => {
      if (closed) return;
      send('error', { code, message });
      closed = true;
    },
  };
}
