/**
 * chat 并发闸门。为什么这么设计：
 *
 * 一次对话会占住一条 LLM 流几十秒，不设上限的话几次连点就能把端点的
 * 并发额度吃光（429）。这里做成与传输无关的小对象：tryAcquire/release，
 * 全局单例 chatGate 由 routes.ts 使用；单测不经过 HTTP 也能验证上限语义。
 */

export interface ChatGate {
  readonly size: number;
  /** 占位成功返回 true；已满返回 false（调用方回 429 chat_busy） */
  tryAcquire(): boolean;
  release(): void;
}

export function createChatGate(limit = 2): ChatGate {
  let inFlight = 0;
  return {
    get size() {
      return inFlight;
    },
    tryAcquire() {
      if (inFlight >= limit) return false;
      inFlight += 1;
      return true;
    },
    release() {
      inFlight = Math.max(0, inFlight - 1);
    },
  };
}

/** 全局单例：同一时刻在飞对话最多 2 个（超过返回 429 chat_busy） */
export const chatGate = createChatGate(2);
