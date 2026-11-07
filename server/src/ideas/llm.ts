/**
 * OpenAI 兼容 chat completions 客户端 + 抗造的 JSON 抽取。
 *
 * 为什么手写 fetch 而不是用 openai SDK：
 *   1. 这个仓库的依赖是锁死的（不许改 package.json），内置 fetch 零依赖；
 *   2. 我们要自己控制超时/重试/截断判定，SDK 的错误包装反而挡路。
 *
 * 为什么 JSON 抽取要单独写一个 extractJson：
 *   生产里模型返回的「JSON」从来不是干净 JSON——```json 围栏、前面一段
 *   「好的，以下是选题：」、被 maxTokens 砍掉一半的数组，全见过。
 *   直接 JSON.parse 会把「截断」误报成「格式错误」，用户看到的是没用的
 *   「模型返回异常」，而不是「输出被截断，请减少数量」。
 */

import type { AppConfig } from '../config.js';

/** 单次请求默认超时。选题生成实测 60–90s（8000 maxTokens），留 120s 余量。 */
const DEFAULT_TIMEOUT_MS = 120_000;
/** 429 / 5xx 重试次数（不含首次）。 */
const DEFAULT_RETRIES = 2;
/** 指数退避基数：500ms、1000ms。不做随机抖动，便于测试断言与日志对账。 */
const BACKOFF_BASE_MS = 500;

/** 未配置 LLM 端点/密钥。HTTP 层应映射为 503 + code=llm_not_configured。 */
export class LlmNotConfiguredError extends Error {
  readonly code = 'llm_not_configured';
  constructor(message = '未配置 LLM：需要 LLM_BASE_URL 与 LLM_API_KEY（OpenAI 兼容端点）') {
    super(message);
    this.name = 'LlmNotConfiguredError';
  }
}

/**
 * 模型输出无法当作 JSON 使用。
 * `truncated` 是关键：为 true 说明是输出被 maxTokens 截断（上下文/数量问题），
 * 而不是模型胡说——上层据此给出「请减少数量」这种可执行建议。
 */
export class LlmJsonError extends Error {
  readonly truncated: boolean;
  constructor(message: string, truncated: boolean) {
    super(message);
    this.name = 'LlmJsonError';
    this.truncated = truncated;
  }
}

/** 非 2xx 响应（重试耗尽后）。 */
export class LlmHttpError extends Error {
  readonly status: number;
  readonly detail: string;
  constructor(status: number, detail: string) {
    super(`LLM 返回 HTTP ${status}：${detail.slice(0, 300)}`);
    this.name = 'LlmHttpError';
    this.status = status;
    this.detail = detail;
  }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  /** 覆盖默认 120s 超时（测试与短任务用） */
  timeoutMs?: number;
  /** 覆盖默认重试次数 */
  retries?: number;
  /**
<<<<<<< ours
   * 思考模式开关（t24）：'disabled' 时请求体带 thinking:{type:"disabled"}。
   * 智谱 GLM-5.3-Flash 等思考型模型支持该参数——翻译/抽取这类机械任务关掉思考
   * 实测省 ~90% token 与等待（10 token 出译文 vs 思考模式 144 token）。
   * 不传 = 不携带该字段（端点用自身默认行为，非思考型模型也兼容）。
   */
  thinking?: 'disabled' | 'enabled';
  /**
   * 外部取消信号（例如 HTTP 客户端断开）。**仅 completeStream 生效**：
   * 与超时信号合并监听，触发后立即中断流；complete() 不读它，行为保持不变。
   */
  signal?: AbortSignal;
}

export interface LlmClient {
  /** 实际使用的模型名，写日志/落库便于回溯 */
  readonly model: string;
  complete(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
  /**
   * 流式补全：请求体 `stream:true`，逐行解析 SSE 增量并经 onToken 回调；
   * 返回值 = 全部增量按序拼接（与 onToken 收到的内容一致：不重、不漏）。
   * 重试/超时/错误分类与 complete() 同规则——但只覆盖「拿到响应头之前」的阶段；
   * 流一旦开始消费就不再重试（token 可能已经发出，重试必然重复输出）。
   */
  completeStream(
    messages: ChatMessage[],
    options: ChatOptions | undefined,
    onToken: (delta: string) => void,
  ): Promise<string>;
}

/** 可注入依赖，测试里换成假 fetch / 假 sleep，不打真网络。 */
export interface LlmDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export function isLlmConfigured(config: AppConfig): boolean {
  return config.llm.baseUrl.trim() !== '' && config.llm.apiKey.trim() !== '';
}

// ------------------------------------------------------------------ JSON 抽取

const stripBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

/**
 * 从 `start` 处的开括号扫到与它配对的闭括号。
 *
 * 必须字符级扫描而不是 indexOf/lastIndexOf：字符串字面量里完全可能出现
 * `[`、`]`、`{`、`}` 和转义引号（例如 solution 里写 "带宽[GB/s]"），
 * 用 lastIndexOf(']') 会切到错误位置并解析失败。单引号也当字符串处理，
 * 因为模型偶尔给单引号 JSON，围栏/前缀同理（围栏字符不含括号，天然被跳过）。
 *
 * @returns `closed=false` 表示扫到结尾仍没闭合 —— 即输出被截断。
 */
function scanBalanced(src: string, start: number): { text: string; closed: boolean } {
  const stack: string[] = [];
  let quote = '';
  let escaped = false;

  for (let i = start; i < src.length; i += 1) {
    const ch = src[i]!;

    if (quote !== '') {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === quote) quote = '';
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '{' || ch === '[') {
      stack.push(ch);
      continue;
    }
    if (ch === '}' || ch === ']') {
      const expected = ch === '}' ? '{' : '[';
      if (stack[stack.length - 1] !== expected) {
        // 括号错配：模型输出的结构已经坏了，别再猜，按不可解析处理
        return { text: src.slice(start, i + 1), closed: false };
      }
      stack.pop();
      if (stack.length === 0) return { text: src.slice(start, i + 1), closed: true };
    }
  }

  return { text: src.slice(start), closed: false };
}

/**
 * 把单引号字符串改写成双引号字符串（只在标准 JSON.parse 失败后作为兜底）。
 * 双引号字符串原样复制；单引号串内部的 `"` 转义成 `\"`，`\'` 还原成 `'`。
 */
function repairSingleQuotedStrings(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;

    if (ch === '"') {
      out += ch;
      i += 1;
      while (i < text.length) {
        const c = text[i]!;
        out += c;
        i += 1;
        if (c === '\\') {
          if (i < text.length) {
            out += text[i]!;
            i += 1;
          }
          continue;
        }
        if (c === '"') break;
      }
      continue;
    }

    if (ch === "'") {
      i += 1;
      let buf = '';
      while (i < text.length && text[i] !== "'") {
        const c = text[i]!;
        if (c === '\\') {
          const next = text[i + 1];
          if (next === "'") {
            buf += "'";
          } else {
            buf += c + (next ?? '');
          }
          i += 2;
          continue;
        }
        buf += c === '"' ? '\\"' : c;
        i += 1;
      }
      i += 1; // 跳过收尾的单引号
      out += `"${buf}"`;
      continue;
    }

    out += ch;
    i += 1;
  }
  return out;
}

/**
 * 从模型回答里抽出第一个 JSON 数组或对象。
 *
 * 顺序：去 BOM → 找第一个 `[`/`{` → 配对扫描 → JSON.parse
 *      → 失败则试「单引号修复」→ 再失败试「去尾逗号」→ 仍失败抛 LlmJsonError。
 *
 * @throws LlmJsonError 未闭合（truncated=true）或无法解析（truncated=false）
 */
export function extractJson(text: string): unknown {
  const src = stripBom(String(text ?? '')).trim();
  // 手写字面量查找而不是正则，避免字符类里 `[` 的转义歧义
  let start = -1;
  for (let i = 0; i < src.length; i += 1) {
    if (src[i] === '[' || src[i] === '{') {
      start = i;
      break;
    }
  }
  if (start === -1) {
    throw new LlmJsonError('模型回答里没有 JSON 对象或数组', src.trim() === '');
  }

  const scanned = scanBalanced(src, start);
  if (!scanned.closed) {
    // 未闭合 = 被 maxTokens 砍断，或者模型还在写就被掐了
    throw new LlmJsonError('模型输出被截断：JSON 未闭合（通常是 maxTokens 不够）', true);
  }

  const raw = scanned.text;
  try {
    return JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // 兜底 1：单引号 JSON（模型常见退化）
    const quoted = repairSingleQuotedStrings(raw);
    if (quoted !== raw) {
      try {
        return JSON.parse(quoted);
      } catch {
        /* 继续下一个兜底 */
      }
    }

    // 兜底 2：尾随逗号 {"a":1,}
    const trimmedCommas = raw.replace(/,\s*([}\]])/gu, '$1');
    if (trimmedCommas !== raw) {
      try {
        return JSON.parse(trimmedCommas);
      } catch {
        /* 落到抛错 */
      }
    }

    throw new LlmJsonError(`模型返回的 JSON 无法解析：${message}`, false);
  }
}

// ------------------------------------------------------------------ 客户端

const sleepDefault = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** baseUrl 末尾斜杠与 /chat/completions 的拼接要幂等，否则会拼出 //chat。 */
function chatCompletionsUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/u, '');
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
}

/** 兼容 content 为字符串或分段数组（部分兼容端点按 OpenAI 新版返回数组）。 */
function readContent(payload: unknown): string {
  const choices = (payload as { choices?: unknown })?.choices;
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const first = choices[0] as { message?: { content?: unknown }; text?: unknown };
  const content = first?.message?.content ?? first?.text;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const text = (part as { text?: unknown })?.text;
        return typeof text === 'string' ? text : '';
      })
      .join('');
  }
  return '';
}

export interface StreamDelta {
  /** true = 服务端宣告结束（`data: [DONE]`） */
  done: boolean;
  /** 本行携带的文本增量；没有增量为空串 */
  delta: string;
}

/**
 * 解析流式响应的一行 SSE。
 *
 * 必须容忍的现实情况：空行（SSE 事件分隔）、`:` 开头的注释行（keepalive 心跳）、
 * data 后没有空格、delta.content 为分段数组（OpenAI 新式端点）、单个端点
 * 混发 message.content 的非标准增量。解析不了的 data 行直接跳过而不是抛错——
 * 一条脏行不该杀掉整条已经吐了一半的回答。
 */
export function parseStreamDelta(line: string): StreamDelta | undefined {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith(':')) return undefined;
  if (!trimmed.startsWith('data:')) return undefined;
  const payload = trimmed.slice(5).trim();
  if (payload === '[DONE]') return { done: true, delta: '' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return undefined;
  }
  const choices = (parsed as { choices?: unknown })?.choices;
  if (!Array.isArray(choices) || choices.length === 0) return { done: false, delta: '' };
  const first = choices[0] as {
    delta?: { content?: unknown };
    message?: { content?: unknown };
    text?: unknown;
  };
  const content = first?.delta?.content ?? first?.message?.content ?? first?.text;
  if (typeof content === 'string') return { done: false, delta: content };
  if (Array.isArray(content)) {
    return {
      done: false,
      delta: content
        .map((part) => {
          const text = (part as { text?: unknown })?.text;
          return typeof text === 'string' ? text : '';
        })
        .join(''),
    };
  }
  return { done: false, delta: '' };
}

/**
 * 创建客户端。**未配置即抛**：让 API 层在发出任何请求前就能返回 503，
 * 而不是等 120s 超时后报一个看不懂的 fetch failed。
 */
export function createLlm(config: AppConfig, deps: LlmDeps = {}): LlmClient {
  if (!isLlmConfigured(config)) throw new LlmNotConfiguredError();

  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? sleepDefault;
  const url = chatCompletionsUrl(config.llm.baseUrl);
  const model = config.llm.model;

  return {
    model,
    async complete(messages, options = {}) {
      if (messages.length === 0) throw new Error('LLM 调用缺少 messages');

      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const retries = options.retries ?? DEFAULT_RETRIES;
      const body = JSON.stringify({
        model,
        messages,
        temperature: options.temperature ?? config.llm.temperature,
        max_tokens: options.maxTokens ?? config.llm.maxTokens,
        stream: false,
        // 思考模式开关（t24）：仅显式传入时携带，避免影响不支持该参数的端点
        ...(options.thinking !== undefined ? { thinking: { type: options.thinking } } : {}),
      });

      let lastError: Error | null = null;

      for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
          const response = await doFetch(url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${config.llm.apiKey}`,
            },
            body,
            signal: AbortSignal.timeout(timeoutMs),
          });

          // 429 是配额/并发限流，5xx 是上游抖动：都值得退避重试
          if (response.status === 429 || response.status >= 500) {
            const detail = await response.text().catch(() => '');
            lastError = new LlmHttpError(response.status, detail);
            if (attempt < retries) {
              await sleep(BACKOFF_BASE_MS * 2 ** attempt);
              continue;
            }
            throw lastError;
          }

          if (!response.ok) {
            const detail = await response.text().catch(() => '');
            // 4xx（401 密钥错、400 参数错）重试没用，直接失败，别浪费时间和额度
            throw new LlmHttpError(response.status, detail);
          }

          const payload: unknown = await response.json();
          const text = readContent(payload).trim();
          if (text === '') throw new Error('LLM 返回了空内容（choices[0].message.content 为空）');
          return text;
        } catch (error) {
          if (error instanceof LlmHttpError) throw error;
          const err = error instanceof Error ? error : new Error(String(error));
          if (err.name === 'TimeoutError' || err.name === 'AbortError') {
            throw new Error(`LLM 请求超时（${timeoutMs}ms）：${url}`);
          }
          lastError = err;
          // 网络级错误（fetch failed / DNS）也值得再试一次
          if (attempt < retries) {
            await sleep(BACKOFF_BASE_MS * 2 ** attempt);
            continue;
          }
          throw err;
        }
      }

      throw lastError ?? new Error('LLM 调用失败：未知原因');
    },

    async completeStream(messages, options = {}, onToken) {
      if (messages.length === 0) throw new Error('LLM 调用缺少 messages');

      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const retries = options.retries ?? DEFAULT_RETRIES;
      const body = JSON.stringify({
        model,
        messages,
        temperature: options.temperature ?? config.llm.temperature,
        max_tokens: options.maxTokens ?? config.llm.maxTokens,
        stream: true,
      });

      let lastError: Error | null = null;

      for (let attempt = 0; attempt <= retries; attempt += 1) {
        let response: Response;
        try {
          // 外部取消与超时合并监听：任一触发都掐断请求。Node >=20 提供 AbortSignal.any。
          const signal = options.signal
            ? AbortSignal.any([AbortSignal.timeout(timeoutMs), options.signal])
            : AbortSignal.timeout(timeoutMs);
          response = await doFetch(url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${config.llm.apiKey}`,
            },
            body,
            signal,
          });
        } catch (error) {
          // 外部主动取消：原样抛出，上层（路由）按「客户端已断开」处理，不报超时
          if (options.signal?.aborted) throw error;
          const err = error instanceof Error ? error : new Error(String(error));
          if (err.name === 'TimeoutError' || err.name === 'AbortError') {
            throw new Error(`LLM 请求超时（${timeoutMs}ms）：${url}`);
          }
          lastError = err;
          if (attempt < retries) {
            await sleep(BACKOFF_BASE_MS * 2 ** attempt);
            continue;
          }
          throw err;
        }

        // 429 / 5xx 与 complete() 同规则：退避重试；此时还没吐 token，重试安全
        if (response.status === 429 || response.status >= 500) {
          const detail = await response.text().catch(() => '');
          lastError = new LlmHttpError(response.status, detail);
          if (attempt < retries) {
            await sleep(BACKOFF_BASE_MS * 2 ** attempt);
            continue;
          }
          throw lastError;
        }
        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          throw new LlmHttpError(response.status, detail);
        }

        // 进入流：此后不再重试——token 可能已经通过 onToken 发出，重来必然重复
        if (!response.body) throw new Error('LLM 流式响应缺少 body');
        const full: string[] = [];
        const decoder = new TextDecoder();
        let buffer = '';
        let finished = false;
        try {
          for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
            buffer += decoder.decode(chunk, { stream: true });
            let newlineAt = buffer.indexOf('\n');
            while (newlineAt >= 0) {
              const line = buffer.slice(0, newlineAt);
              buffer = buffer.slice(newlineAt + 1);
              const delta = parseStreamDelta(line);
              if (delta) {
                if (delta.done) {
                  finished = true;
                  break;
                }
                if (delta.delta !== '') {
                  full.push(delta.delta);
                  onToken(delta.delta);
                }
              }
              newlineAt = buffer.indexOf('\n');
            }
            if (finished) break;
          }
        } catch (error) {
          if (options.signal?.aborted) throw error;
          const err = error instanceof Error ? error : new Error(String(error));
          if (err.name === 'TimeoutError' || err.name === 'AbortError') {
            throw new Error(`LLM 请求超时（${timeoutMs}ms）：${url}`);
          }
          throw err;
        }
        // 兜底：有的端点不发 [DONE] 就直接关流，把缓冲区里最后一整行也消费掉
        if (!finished) {
          const tail = parseStreamDelta(buffer);
          if (tail && !tail.done && tail.delta !== '') {
            full.push(tail.delta);
            onToken(tail.delta);
          }
        }

        const text = full.join('');
        if (text.trim() === '') throw new Error('LLM 返回了空内容（流式响应无有效增量）');
        return text;
      }

      throw lastError ?? new Error('LLM 调用失败：未知原因');
    },
  };
}
