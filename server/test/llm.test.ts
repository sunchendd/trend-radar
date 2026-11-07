import { describe, expect, it } from 'vitest';

import type { AppConfig } from '../src/config.js';
import {
  LlmHttpError,
  LlmJsonError,
  LlmNotConfiguredError,
  createLlm,
  extractJson,
  parseStreamDelta,
} from '../src/ideas/llm.js';

describe('extractJson：6 种脏输入', () => {
  it('① 围栏：```json 包裹', () => {
    const text = ['好的：', '```json', '[{"title":"A","n":1}]', '```'].join('\n');
    expect(extractJson(text)).toEqual([{ title: 'A', n: 1 }]);
  });

  it('② 前后带解释文字', () => {
    const text = '以下是 3 条选题，请审阅：\n[{"title":"A"}]\n希望对你有帮助，如需调整告诉我。';
    expect(extractJson(text)).toEqual([{ title: 'A' }]);
  });

  it('③ 字符串里含括号与转义引号、数组里嵌套数组', () => {
    const text = String.raw`{"solution":"带宽[GB/s]提升，参考{图2}与 \"[x]\" 的写法","n":[1,[2,3]]}`;
    expect(extractJson(text)).toEqual({
      solution: '带宽[GB/s]提升，参考{图2}与 "[x]" 的写法',
      n: [1, [2, 3]],
    });
  });

  it('④ 截断：未闭合 → 抛错且 truncated=true', () => {
    const text = '[{"title":"A","solution":"很长的一段方案文本，写到一半就被 maxTokens 砍掉';
    let caught: unknown;
    try {
      extractJson(text);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(LlmJsonError);
    const error = caught as LlmJsonError;
    expect(error.truncated).toBe(true);
    expect(error.message).toContain('截断');
  });

  it('⑤ 单引号 JSON（模型常见退化）→ 兜底修复后能解析', () => {
    const text = "{'title': '基于分级缓存的退出方法', 'n': 1, 'tags': ['a', 'b']}";
    expect(extractJson(text)).toEqual({ title: '基于分级缓存的退出方法', n: 1, tags: ['a', 'b'] });
  });

  it('⑥ BOM 前缀', () => {
    const text = `\uFEFF[{"title":"A"}]`;
    expect(extractJson(`\uFEFFresult: ${text.replace('\uFEFF', '')}`)).toEqual([{ title: 'A' }]);
    expect(extractJson(text)).toEqual([{ title: 'A' }]);
  });

  it('取第一个 JSON 而不是最后一个（后面还跟了别的括号）', () => {
    expect(extractJson('前言 [1,2] 后面还有一个 {"a":1}')).toEqual([1, 2]);
  });

  it('没有 JSON → 抛非截断错误', () => {
    let caught: unknown;
    try {
      extractJson('抱歉，我无法完成这个请求。');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LlmJsonError);
    expect((caught as LlmJsonError).truncated).toBe(false);
  });

  it('尾随逗号也容忍（模型常见）', () => {
    expect(extractJson('[{"title":"A",},]')).toEqual([{ title: 'A' }]);
  });
});

const makeConfig = (over: Partial<AppConfig['llm']> = {}): AppConfig => ({
  dataDir: '/tmp/trend-radar-test',
  port: 8787,
  host: '127.0.0.1',
  collectMinutes: 0,
  minKeepScore: 0,
  limitPerSource: 10,
  ttlDays: 30,
  llm: { baseUrl: 'https://llm.example/v1', apiKey: 'sk-test', model: 'test-model', temperature: 0.7, maxTokens: 256, ...over },
  novelty: { command: '', agreeKick: false },
  translation: { enabled: true, dailyLimit: 500 },
  bark: { url: '', enabled: true },
});

describe('createLlm：配置与重试', () => {
  it('未配置 baseUrl/apiKey → LlmNotConfiguredError（映射 503）', () => {
    expect(() => createLlm(makeConfig({ apiKey: '' }))).toThrow(LlmNotConfiguredError);
    expect(() => createLlm(makeConfig({ baseUrl: '' }))).toThrow(LlmNotConfiguredError);
    try {
      createLlm(makeConfig({ baseUrl: '   ' }));
    } catch (error) {
      expect((error as LlmNotConfiguredError).code).toBe('llm_not_configured');
    }
  });

  it('429 → 指数退避重试后成功，URL 拼接不重复 /chat/completions', async () => {
    const urls: string[] = [];
    const delays: number[] = [];
    const fetchStub = (async (input: string | URL | Request) => {
      urls.push(String(input));
      if (urls.length === 1) return new Response('rate limited', { status: 429 });
      return new Response(JSON.stringify({ choices: [{ message: { content: ' [{"ok":true}] ' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const llm = createLlm(makeConfig({ baseUrl: 'https://llm.example/v1/' }), {
      fetch: fetchStub,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    const text = await llm.complete([{ role: 'user', content: 'hi' }]);

    expect(text).toBe('[{"ok":true}]');
    expect(urls).toEqual(['https://llm.example/v1/chat/completions', 'https://llm.example/v1/chat/completions']);
    expect(delays).toEqual([500]);
  });

  it('持续 5xx → 重试 2 次后抛 LlmHttpError（共 3 次请求）', async () => {
    let calls = 0;
    const delays: number[] = [];
    const fetchStub = (async () => {
      calls += 1;
      return new Response('upstream boom', { status: 503 });
    }) as unknown as typeof fetch;

    const llm = createLlm(makeConfig(), {
      fetch: fetchStub,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    let caught: unknown;
    try {
      await llm.complete([{ role: 'user', content: 'hi' }]);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(LlmHttpError);
    expect((caught as LlmHttpError).status).toBe(503);
    expect(calls).toBe(3); // 首次 + 2 次重试
    expect(delays).toEqual([500, 1000]);
  });

  it('401 不重试（密钥错重试没意义）', async () => {
    let calls = 0;
    const fetchStub = (async () => {
      calls += 1;
      return new Response('bad key', { status: 401 });
    }) as unknown as typeof fetch;

    const llm = createLlm(makeConfig(), { fetch: fetchStub, sleep: async () => undefined });

    await expect(llm.complete([{ role: 'user', content: 'hi' }])).rejects.toBeInstanceOf(LlmHttpError);
    expect(calls).toBe(1);
  });
});

// ---------------------------------------------------------------- completeStream

/** 用 ReadableStream 拼一个会分块吐 SSE 的 Response（不出网） */
const streamResponse = (chunks: string[]): Response => {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
};

describe('parseStreamDelta：单行解析', () => {
  it('标准 data 行取 delta.content；[DONE] 标记结束', () => {
    expect(parseStreamDelta('data: {"choices":[{"delta":{"content":"你"}}]}')).toEqual({ done: false, delta: '你' });
    expect(parseStreamDelta('data: [DONE]')).toEqual({ done: true, delta: '' });
  });

  it('容忍空行、注释行、无空格的 data:、坏 JSON', () => {
    expect(parseStreamDelta('')).toBeUndefined();
    expect(parseStreamDelta(': ping')).toBeUndefined();
    expect(parseStreamDelta('data:{"choices":[{"delta":{"content":"a"}}]}')).toEqual({ done: false, delta: 'a' });
    expect(parseStreamDelta('data: {不是JSON')).toBeUndefined();
    expect(parseStreamDelta('event: ping')).toBeUndefined();
  });

  it('delta.content 为分段数组时拼接 text；缺 delta 时给空增量', () => {
    expect(parseStreamDelta('data: {"choices":[{"delta":{"content":[{"text":"世"},{"text":"界"}]}}]}')).toEqual({
      done: false,
      delta: '世界',
    });
    expect(parseStreamDelta('data: {"choices":[{}]}')).toEqual({ done: false, delta: '' });
  });
});

describe('completeStream：分块解析与错误语义', () => {
  it('跨块断行按序拼接：不重不漏；空 delta、注释行、分段数组、[DONE] 都正确处理', async () => {
    const chunks = [
      ': keepalive\n\n', // 注释行要跳过
      'data: {"choices":[{"delta":{"content":"你"}}]}\n\ndata: {"choi', // 帧被砍在中间
      'ces":[{"delta":{"content":"好"}}]}\n\ndata: {"choices":[{"delta":{"content":""}}]}\n\n', // 空 delta
      'data: {"choices":[{"delta":{"content":[{"text":"，"},{"text":"世界"}]}}]}\n\n', // 分段数组
      'data: [DONE]\n\n',
    ];
    const fetchStub = (async () => streamResponse(chunks)) as unknown as typeof fetch;
    const llm = createLlm(makeConfig(), { fetch: fetchStub });

    const tokens: string[] = [];
    const text = await llm.completeStream([{ role: 'user', content: 'hi' }], undefined, (delta) => tokens.push(delta));

    expect(text).toBe('你好，世界');
    // 一行 data 的分段数组合成一个增量；不重不漏
    expect(tokens).toEqual(['你', '好', '，世界']);
  });

  it('不发 [DONE] 直接关流的端点：已收增量原样返回', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"部"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"分"}}]}', // 没有结尾换行也没有 [DONE]
    ];
    const fetchStub = (async () => streamResponse(chunks)) as unknown as typeof fetch;
    const llm = createLlm(makeConfig(), { fetch: fetchStub });

    const tokens: string[] = [];
    const text = await llm.completeStream([{ role: 'user', content: 'hi' }], undefined, (d) => tokens.push(d));
    expect(text).toBe('部分');
    expect(tokens).toEqual(['部', '分']);
  });

  it('429 先退避重试，第二次拿到流；响应体 stream:true', async () => {
    const bodies: string[] = [];
    const delays: number[] = [];
    let calls = 0;
    const fetchStub = (async (_input: string | URL, init?: RequestInit) => {
      calls += 1;
      bodies.push(String((JSON.parse(String(init?.body)) as { stream?: boolean }).stream));
      if (calls === 1) return new Response('rate limited', { status: 429 });
      return streamResponse(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n']);
    }) as unknown as typeof fetch;

    const llm = createLlm(makeConfig(), {
      fetch: fetchStub,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    const text = await llm.completeStream([{ role: 'user', content: 'hi' }], undefined, () => {});
    expect(text).toBe('ok');
    expect(calls).toBe(2);
    expect(delays).toEqual([500]);
    expect(bodies.every((flag) => flag === 'true')).toBe(true);
  });

  it('持续 5xx 重试耗尽 → LlmHttpError；401 直接失败不重试', async () => {
    let boomCalls = 0;
    const boom = (async () => {
      boomCalls += 1;
      return new Response('upstream', { status: 503 });
    }) as unknown as typeof fetch;
    const llmBoom = createLlm(makeConfig(), { fetch: boom, sleep: async () => undefined });
    await expect(llmBoom.completeStream([{ role: 'user', content: 'hi' }], undefined, () => {})).rejects.toBeInstanceOf(
      LlmHttpError,
    );
    expect(boomCalls).toBe(3); // 首次 + 2 次重试

    let unauthorizedCalls = 0;
    const unauthorized = (async () => {
      unauthorizedCalls += 1;
      return new Response('bad key', { status: 401 });
    }) as unknown as typeof fetch;
    const llmUnauthorized = createLlm(makeConfig(), { fetch: unauthorized, sleep: async () => undefined });
    await expect(
      llmUnauthorized.completeStream([{ role: 'user', content: 'hi' }], undefined, () => {}),
    ).rejects.toBeInstanceOf(LlmHttpError);
    expect(unauthorizedCalls).toBe(1);
  });

  it('全程无有效增量（只有注释行）→ 报空内容', async () => {
    const fetchStub = (async () => streamResponse([': ping\n\n', 'data: [DONE]\n\n'])) as unknown as typeof fetch;
    const llm = createLlm(makeConfig(), { fetch: fetchStub });
    await expect(llm.completeStream([{ role: 'user', content: 'hi' }], undefined, () => {})).rejects.toThrow(/空内容/);
  });

  it('外部 signal 取消：立即 rejects，onToken 未收到任何增量', async () => {
    const fetchStub = (async (_input: string | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as unknown as typeof fetch;
    const llm = createLlm(makeConfig(), { fetch: fetchStub });

    const controller = new AbortController();
    const tokens: string[] = [];
    const pending = llm.completeStream([{ role: 'user', content: 'hi' }], { signal: controller.signal }, (d) =>
      tokens.push(d),
    );
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(tokens).toEqual([]);
  });

  it('外部 signal 已中止时不误报成超时', async () => {
    const fetchStub = (async () => {
      throw new DOMException('aborted', 'AbortError');
    }) as unknown as typeof fetch;
    const llm = createLlm(makeConfig(), { fetch: fetchStub });
    const controller = new AbortController();
    controller.abort();
    await expect(
      llm.completeStream([{ role: 'user', content: 'hi' }], { signal: controller.signal }, () => {}),
    ).rejects.toThrow(/aborted/);
  });
});
