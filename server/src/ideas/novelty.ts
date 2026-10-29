/**
 * 智慧芽（PatSnap）查新对接：跑外部 CLI，把命中数/头部申请人变成 NoveltyRecord[]。
 *
 * 为什么走外部 CLI 而不是调 API：
 *   智慧芽没有公开的检索 API，生产上用的是 zhihuiya-patent-search skill 的
 *   batch_search.sh（agent-browser 驱动浏览器），所以这里只是「调子进程 + 解析」，
 *   不自己造一套检索实现。
 *
 * 两条纪律（都在生产上验证过）：
 *   1. CLI 跑不起来就报 503，绝不静默返回空数组——空数组会被误读成「没命中」，
 *      进而被判成「技术空白」，这是最贵的错误；
 *   2. 全零时按纪律自动减词重试一次（简单搜索是 AND 语义，词多即空）。
 */

import { spawn } from 'node:child_process';
import { accessSync, constants as fsConstants } from 'node:fs';

import type { AppConfig } from '../config.js';
import type { Idea, NoveltyRecord } from '../types.js';
// 复用 llm.ts 的配对扫描：CLI 偶尔会在 JSON 前打印日志行，同样的「找配对括号」逻辑
import { extractJson } from './llm.js';
import { synonymRewrites } from './prompts.js';

/** CLI 不可用时抛这个。HTTP 层映射为 503 + code=novelty_not_configured。 */
export class NoveltyNotConfiguredError extends Error {
  readonly code = 'novelty_not_configured';
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'NoveltyNotConfiguredError';
  }
}

/** 默认超时 15 分钟：一批 5 条检索式约 60–70s，但登录态重建可能拖很久。 */
const DEFAULT_TIMEOUT_MS = 900_000;
/** 一次最多跑几条检索式。skill 文档：一批 5–6 条最合适，再多浏览器容易掉登录。 */
const DEFAULT_QUERY_LIMIT = 5;
/** stdout/stderr 上限，防止异常输出吃满内存。 */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export interface RunCommandOptions {
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
}

/** 可注入的命令执行器，测试里换成假 CLI。 */
export type CommandRunner = (command: string, args: string[], options: RunCommandOptions) => Promise<CommandResult>;

export interface NoveltyRunOptions {
  /** 覆盖 config.novelty.command（测试/多环境） */
  command?: string;
  timeoutMs?: number;
  /** 每次最多跑几条检索式 */
  limit?: number;
  /** 注入假 CLI：不打真浏览器 */
  runCommand?: CommandRunner;
  now?: () => Date;
  /** 额外环境变量（合并进 process.env） */
  env?: NodeJS.ProcessEnv;
}

/** 选题里只需要这两样：标题进日志、queries 是检索式来源。 */
export type NoveltyIdea = Pick<Idea, 'queries'> & Partial<Pick<Idea, 'title'>>;

interface RawRow {
  q?: unknown;
  count?: unknown;
  apps?: unknown;
  pats?: unknown;
}

// ---------------------------------------------------------------- CLI 调用

/**
 * 默认执行器。`.sh` 用 bash 显式解释（不依赖可执行位/shebang），
 * 其余命令直接 spawn；超时自己计时而不是用 spawn 的 timeout 选项，
 * 因为 spawn 超时只会给 signal，分不清「被超时杀了」还是「自己崩了」。
 */
const spawnRunner: CommandRunner = (command, args, { timeoutMs, env }) => {
  return new Promise<CommandResult>((resolve, reject) => {
    const isScript = command.endsWith('.sh');
    const file = isScript ? 'bash' : command;
    const argv = isScript ? [command, ...args] : args;

    const child = spawn(file, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (error: Error | null, result?: CommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result ?? { stdout, stderr });
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`CLI 超时（${timeoutMs}ms 未返回）`));
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > MAX_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        finish(new Error('CLI stdout 超过 8MB，疑似输出异常'));
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > MAX_OUTPUT_BYTES) stderr = stderr.slice(-MAX_OUTPUT_BYTES);
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      const hint = error.code === 'ENOENT' ? '命令不存在' : String(error.code ?? error.message);
      finish(new Error(`CLI 启动失败（${hint}）`));
    });

    child.on('close', (code, signal) => {
      if (code === 0) {
        finish(null, { stdout, stderr });
        return;
      }
      const tail = stderr.trim().split('\n').slice(-3).join(' | ');
      finish(new Error(`CLI 退出码 ${String(code ?? signal)}：${tail === '' ? '（无 stderr）' : tail}`));
    });
  });
};

/** 命令带路径时先自己检查一次，给出比 spawn ENOENT 更可读的报错。 */
function assertCommandExists(command: string): void {
  if (!command.includes('/')) return; // 裸命令交给 PATH 解析
  try {
    accessSync(command, fsConstants.X_OK);
  } catch (error) {
    throw new NoveltyNotConfiguredError(`智慧芽 CLI 不存在或不可执行：${command}（检查 ZHY_COMMAND 配置）`, {
      cause: error,
    });
  }
}

/** 检索式参数形态：每条一个独立的 argv，与 batch_search.sh 的 `"q1" "q2"` 用法一致。 */
function toArgs(queries: string[]): string[] {
  return [...queries];
}

/** 把 "1,234" / 509 / null 统一成 number | null（null 表示解析失败，0 表示真的没有）。 */
export function parseHits(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null;
  const cleaned = String(value).replace(/[,，\s]/gu, '');
  if (cleaned === '') return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry)).filter((entry) => entry.trim() !== '');
}

/** CLI 的 stdout 是 JSON 数组；容忍前面混进日志行（以防某天 CLI 往 stdout 打进度）。 */
export function parseCliOutput(stdout: string): RawRow[] {
  const text = stdout.trim();
  if (text === '') throw new Error('CLI 输出为空');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 日志前缀 / 尾部提示都不影响配对扫描
    parsed = extractJson(text);
  }
  if (!Array.isArray(parsed)) throw new Error(`CLI 输出不是 JSON 数组：${text.slice(0, 200)}`);
  return parsed as RawRow[];
}

function toRecords(rows: RawRow[], at: string): NoveltyRecord[] {
  return rows.map((row) => {
    const hits = parseHits(row.count);
    const apps = asStringList(row.apps);
    const pats = asStringList(row.pats);
    const samples = pats
      .slice(0, 2)
      .map((entry) => entry.split(' | ')[0]?.trim() ?? '')
      .filter((entry) => entry !== '');
    return {
      at,
      query: String(row.q ?? '').trim(),
      hits,
      topAssignees: apps.slice(0, 3).join('、'),
      note:
        `自动查新（智慧芽）：命中 ${hits === null ? '解析失败' : hits}` +
        (samples.length === 0 ? '' : `，样例 ${samples.join(', ')}`),
      site: 'zhihuiya',
    };
  });
}

/** 全零判定：只看取到数的记录；有一条 null 就不算「全零」（那是解析失败，减词没用）。 */
function isAllZero(records: NoveltyRecord[]): boolean {
  const parsed = records.filter((r) => r.hits !== null);
  return parsed.length > 0 && records.length === parsed.length && parsed.every((r) => r.hits === 0);
}

/**
 * 单条减词：去掉最后一个词，且必须仍 ≥3 词。
 * 3 词以下已经是「宽检索」，再减就变成单概念检索，命中数没有意义。
 */
export function relaxQuery(query: string): string | null {
  const words = query.trim().split(/\s+/u).filter((word) => word !== '');
  return words.length > 3 ? words.slice(0, -1).join(' ') : null;
}

/**
 * 整批减词：每条都要能减，否则整体放弃（混着跑会让命中数失去可比性）。
 * 保留这个导出是因为「整批口径」是给调用方看的约定，单条实现见 relaxQuery。
 */
export function relaxQueries(queries: string[]): string[] | null {
  const relaxed: string[] = [];
  for (const query of queries) {
    const next = relaxQuery(query);
    if (next === null) return null;
    relaxed.push(next);
  }
  return relaxed.length === queries.length && relaxed.length > 0 ? relaxed : null;
}

export type RetryKind = 'relaxed' | 'synonym' | 'original';

export interface RetryCandidate {
  query: string;
  kind: RetryKind;
  /** 同义改写时被替换的原文（写进 note，便于解释命中数为何变化） */
  from?: string;
  to?: string;
}

/**
 * 全零后的重试候选。
 *
 * 两类改法，**主候选保证与原始检索式一一对齐**（顺序、条数不变），
 * 这样重试后的命中数表仍然能和首轮对照着看：
 *   1. 减词（primary）：去掉尾词，命中了就说明是检索式过窄；
 *   2. 同义改写（primary 或 secondary）：把实测会压低命中数的词换成词库写法，
 *      比如「KV压缩」→「KV缓存」——同一个方案换词，命中数能从 0 跳到几十。
 * 第二候选只在预算（limit）还有空位时补，避免一次跑太多把浏览器拖掉登录。
 */
export function buildRetryCandidates(queries: string[], limit = DEFAULT_QUERY_LIMIT): RetryCandidate[] {
  const baseSet = new Set(queries.map((query) => query.trim()));
  const primaries: RetryCandidate[] = [];
  const secondaries: RetryCandidate[] = [];
  const seen = new Set<string>();

  const push = (target: RetryCandidate[], candidate: RetryCandidate): void => {
    const text = candidate.query.trim();
    if (text === '') return;
    // 「原样重跑」本来就和首轮同文，不能按 baseSet 过滤掉，否则命中数表会缺行
    if (candidate.kind !== 'original' && baseSet.has(text)) return;
    if (seen.has(text)) return;
    seen.add(text);
    target.push({ ...candidate, query: text });
  };

  for (const query of queries) {
    const relaxed = relaxQuery(query);
    const rewrites = synonymRewrites(query);

    if (relaxed !== null) push(primaries, { query: relaxed, kind: 'relaxed' });
    else if (rewrites.length > 0) {
      const first = rewrites[0]!;
      push(primaries, { query: first.text, kind: 'synonym', from: first.from, to: first.to });
    } else {
      // 既不能减词也没有同义词可换：原样重跑，保持与首轮一一对齐
      push(primaries, { query, kind: 'original' });
    }

    // 第二候选：减词之后还愿意再试一次同义改写（用剩余预算）
    if (relaxed !== null && rewrites.length > 0) {
      const first = rewrites[0]!;
      push(secondaries, { query: first.text, kind: 'synonym', from: first.from, to: first.to });
    }
  }

  // unique.length ≤ limit，所以主候选一定装得下；预算只用来限制第二候选
  const merged = [...primaries, ...secondaries];
  return merged.slice(0, Math.max(1, limit));
}

// ---------------------------------------------------------------- 对外入口

/**
 * 跑一次查新，返回逐条检索式的记录（不判读——判读在 verdict.ts）。
 *
 * @param queries 指定检索式；省略时取 idea.queries
 */
export async function runNovelty(
  config: AppConfig,
  idea: NoveltyIdea,
  queries?: string[],
  options: NoveltyRunOptions = {},
): Promise<NoveltyRecord[]> {
  const command = (options.command ?? config.novelty.command ?? '').trim();
  if (command === '') {
    throw new NoveltyNotConfiguredError('未配置智慧芽 CLI：请设置 ZHY_COMMAND 指向 batch_search.sh');
  }
  assertCommandExists(command);

  const limit = Math.max(1, Math.min(DEFAULT_QUERY_LIMIT, options.limit ?? DEFAULT_QUERY_LIMIT));
  const raw = (queries ?? idea.queries ?? [])
    .map((query) => String(query ?? '').trim())
    .filter((query) => query !== '');
  const unique = [...new Set(raw)].slice(0, limit);
  if (unique.length === 0) throw new Error(`选题「${idea.title ?? '未命名'}」没有可用的查新检索式`);

  const runner = options.runCommand ?? spawnRunner;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? (() => new Date());
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(config.novelty.agreeKick ? { ZHY_AGREE_KICK: '1' } : {}),
    ...(options.env ?? {}),
  };

  const runRows = async (list: string[], label: string): Promise<NoveltyRecord[]> => {
    let stdout: string;
    try {
      const result = await runner(command, toArgs(list), { timeoutMs, env });
      stdout = result.stdout;
    } catch (error) {
      // 不静默返回空：跑不起来就是配置问题，让运维去修
      const message = error instanceof Error ? error.message : String(error);
      throw new NoveltyNotConfiguredError(`智慧芽 CLI 调用失败（${label}）：${message}`, { cause: error });
    }

    let rows: RawRow[];
    try {
      rows = parseCliOutput(stdout);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`智慧芽 CLI 输出无法解析：${message}`);
    }
    if (rows.length === 0) {
      throw new NoveltyNotConfiguredError(
        `智慧芽 CLI 没有返回任何检索结果（${label}）：通常是登录态失效或页面没渲染出来`,
      );
    }
    return toRecords(rows, now().toISOString());
  };

  const records = await runRows(unique, '首轮');
  if (!isAllZero(records)) return records;

  // 全零 → 按纪律重试一次（减词 / 同义改写），避免把「检索式过窄」记成「技术空白」
  const candidates = buildRetryCandidates(unique, limit);
  if (candidates.every((candidate) => candidate.kind === 'original')) {
    // 既减不了词也没有同义词可换，原样重跑只是白等 70 秒，直接交给 verdict 判 inconclusive
    return records;
  }

  const byQuery = new Map(candidates.map((candidate) => [candidate.query, candidate]));
  const retried = await runRows(
    candidates.map((candidate) => candidate.query),
    '减词/同义改写重试',
  );
  return retried.map((record) => {
    const candidate = byQuery.get(record.query);
    if (candidate === undefined || candidate.kind === 'original') {
      return { ...record, note: `原检索式全零，原样重跑；${record.note}` };
    }
    const how =
      candidate.kind === 'synonym'
        ? `同义改写「${candidate.from ?? ''}」→「${candidate.to ?? ''}」`
        : '减词';
    return {
      ...record,
      query: `${record.query}${candidate.kind === 'synonym' ? '（同义改写）' : '（减词）'}`,
      note: `原检索式全零，${how}重试；${record.note}`,
    };
  });
}

/** 供 API 层批量查新时复用：按选题的 queries 跑，返回可直接 append 到 idea.novelty 的记录。 */
export async function runNoveltyForQueries(
  config: AppConfig,
  idea: NoveltyIdea,
  options: NoveltyRunOptions = {},
): Promise<NoveltyRecord[]> {
  return runNovelty(config, idea, undefined, options);
}
