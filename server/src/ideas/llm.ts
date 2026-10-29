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
}

export interface LlmClient {
  /** 实际使用的模型名，写日志/落库便于回溯 */
  readonly model: string;
  complete(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
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
  };
}
