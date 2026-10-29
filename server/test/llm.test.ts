import { describe, expect, it } from 'vitest';

import type { AppConfig } from '../src/config.js';
import { LlmHttpError, LlmJsonError, LlmNotConfiguredError, createLlm, extractJson } from '../src/ideas/llm.js';

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
