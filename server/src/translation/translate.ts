/**
 * 论文/新闻条目自动中文翻译（t18）。
 *
 * 设计要点：
 *  - **复用 ideas/llm.ts 的客户端**：配置同源（settings 页的 LLM 三件套）、
 *    重试/超时/JSON 抽取一个口径，绝不另起一套 HTTP 逻辑；
 *  - **批量合并省配额**：一个请求带 8 条（title+截断 summary），返回 JSON 数组；
 *  - **语言检测**：标题+摘要里含 CJK 字符即视为中文，跳过不花额度；
 *  - **内容指纹（zhKey）**：翻译时存 sha1(title+summary) 前 16 位，下次扫描
 *    key 对不上 = 内容变更过 → 重译；key 相同 = 已翻译且没变 → 跳过（幂等）；
 *  - **每日上限**：今天已翻条数 ≥ dailyLimit 就停，配额是硬闸；
 *  - **降级**：LLM 未配置时 runTranslationPass 直接返回 degraded，
 *    不报错不重试，UI 只在设置页给配置指引。
 */

import { createHash } from 'node:crypto';

import type { AppConfig } from '../config.js';
import { extractJson, isLlmConfigured, type LlmClient } from '../ideas/llm.js';
import type { DatabaseSync } from 'node:sqlite';
import {
  listTranslationCandidates,
  saveTranslations,
  translationCountToday,
  type TranslationCandidate,
  type TranslationSave,
} from '../store/queries.js';
import type { TranslationRunResult } from '../types.js';

/** 哪些 kind 参与翻译：papers 页（paper）+ news 页（news/release） */
const TRANSLATABLE_KINDS = new Set(['paper', 'news', 'release']);
/**
 * 摘要送 LLM 前的分类型截断（t24 扩大覆盖）：news 正文全文（RSS description/
 * content:encoded 存的就是全文）、release note 全文 markdown、论文摘要全文。
 * 上限只防异常超长，不再按 1200 硬截正文。
 */
const SUMMARY_INPUT_LIMITS: Record<string, number> = { paper: 4000, news: 4000, release: 6000 };
const inputLimit = (kind: string): number => SUMMARY_INPUT_LIMITS[kind] ?? 2000;
/** 单次 LLM 请求合并的条目数：8 条 × (标题 ~30 + 摘要 ~500 中文字) 是稳妥的一批 */
export const BATCH_SIZE = 8;
/** 一轮翻译最多跑多少个批次：防止积压一次性把上限外的额度也烧掉（上限本身是硬闸） */
const MAX_BATCHES_PER_PASS = 60;
/** 批次级 JSON 解析失败后的重试次数（不含首次） */
const BATCH_RETRIES = 1;

/** 含 CJK 即视为中文：CJK 统一表意文字 + 扩展A + 兼容表意区 */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;

export function containsCjk(text: string): boolean {
  return CJK.test(text);
}

/** 翻译时的内容指纹：title/summary 任一变了 key 就对不上，触发重译 */
export function contentKey(item: { title: string; summary: string }): string {
  return createHash('sha1').update(`${item.title}\n${item.summary}`, 'utf8').digest('hex').slice(0, 16);
}

/** 单条是否需要翻译：可翻译 kind + 无中文 + 未翻译或内容已变更 */
export function needsTranslation(item: {
  kind: string;
  title: string;
  summary: string;
  zhKey?: string | null;
}): boolean {
  if (!TRANSLATABLE_KINDS.has(item.kind)) return false;
  const text = `${item.title}\n${item.summary}`;
  if (text.trim() === '') return false;
  if (containsCjk(text)) return false;
  return item.zhKey !== contentKey(item);
}

/** LLM 客户端的窄接口（测试注入假 client；生产由 deps.ts 用 createLlm 构造） */
export interface TranslateLlm {
  complete(messages: { role: 'system' | 'user' | 'assistant'; content: string }[], options?: {
    temperature?: number;
    maxTokens?: number;
    timeoutMs?: number;
    retries?: number;
    thinking?: 'disabled' | 'enabled';
  }): Promise<string>;
}

export interface TranslateDeps {
  /** 覆盖数据库句柄（默认由调用方传入；测试用 :memory:） */
  db: DatabaseSync;
  /** LLM 客户端；未配置时传 undefined → 整链路降级 */
  llm?: TranslateLlm;
  now?: Date;
  /** 单批大小（测试压小，比如 2） */
  batchSize?: number;
  /** 覆盖每日上限（默认读 config.translation.dailyLimit） */
  dailyLimit?: number;
  /** 只处理这么多候选（测试收窄扫描面） */
  scanLimit?: number;
}

export interface TranslationPassResult extends TranslationRunResult {
  /** 被跳过的已翻译未变更条数（幂等性的直接证据） */
  alreadyDone: number;
}

const SYSTEM_PROMPT = [
  '你是学术与技术情报翻译引擎。把用户给出的条目标题和摘要翻译成简体中文。',
  '要求：',
  '1. 只输出一个 JSON 数组，不要任何解释、markdown 围栏或多余文字；',
  '2. 数组每项形如 {"id":"原样返回的条目id","titleZh":"标题译文","summaryZh":"摘要译文"}；',
  '3. 专有名词、模型名、数据集名、数字与单位保留原文（如 DeepSeek-V3、speculative decoding 可保留英文术语）；',
  '4. kind=release 的条目：summaryZh 输出**正文全文的简体中文 markdown 翻译**（保留标题/列表/代码块结构），不要概括；',
  '5. 其他条目：summaryZh 用 2-4 句概括要点，忠实原文，不添加评论；摘要为空则输出空字符串。',
].join('\n');

interface BatchInput {
  id: string;
  kind: string;
  title: string;
  summary: string;
}

function buildUserPrompt(batch: BatchInput[]): string {
  const lines = batch.map((item) => {
    const limit = inputLimit(item.kind);
    const summary = item.summary.length > limit ? `${item.summary.slice(0, limit)}…` : item.summary;
    return JSON.stringify({ id: item.id, kind: item.kind, title: item.title, summary });
  });
  return `翻译以下 ${batch.length} 个条目：\n[${lines.join(',\n')}]`;
}

/**
 * 从模型返回的数组里按 id 对账；id 对不上/字段缺失的条目视为失败（留在待翻池）。
 * extractJson 已处理围栏/单引号/截断等脏输出。
 */
function parseBatchAnswer(answer: string, wanted: Set<string>): Map<string, { titleZh: string; summaryZh: string }> {
  const parsed: unknown = extractJson(answer);
  if (!Array.isArray(parsed)) throw new Error('模型输出不是 JSON 数组');
  const byId = new Map<string, { titleZh: string; summaryZh: string }>();
  for (const entry of parsed) {
    const row = entry as { id?: unknown; titleZh?: unknown; summaryZh?: unknown };
    if (typeof row?.id !== 'string' || !wanted.has(row.id)) continue;
    const titleZh = typeof row.titleZh === 'string' ? row.titleZh.trim() : '';
    const summaryZh = typeof row.summaryZh === 'string' ? row.summaryZh.trim() : '';
    if (titleZh === '' && summaryZh === '') continue;
    byId.set(row.id, { titleZh, summaryZh });
  }
  return byId;
}

/** 翻译一个批次（含 1 次解析失败重试）；返回 id→译文，缺失的条目由调用方记为 failed */
async function translateBatch(
  llm: TranslateLlm,
  batch: BatchInput[],
  options: { thinkingDisabled?: boolean } = {},
): Promise<Map<string, { titleZh: string; summaryZh: string }>> {
  const wanted = new Set(batch.map((item) => item.id));
  const userPrompt = buildUserPrompt(batch);
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= BATCH_RETRIES; attempt += 1) {
    try {
      const suffix = attempt > 0 ? '\n\n注意：上一次输出无法解析。这次只输出 JSON 数组本身，从 [ 开始到 ] 结束。' : '';
      const answer = await llm.complete(
        [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt + suffix },
        ],
        {
          temperature: 0.2,
          maxTokens: Math.min(8000, 400 + batch.length * 900),
          timeoutMs: 90_000,
          // t24：思考型模型（GLM-5.3-Flash）关思考，翻译是机械任务（可经 TREND_LLM_THINKING_DISABLED=0 关掉）
          thinking: options.thinkingDisabled === true ? 'disabled' : undefined,
        },
      );
      const parsed = parseBatchAnswer(answer, wanted);
      if (parsed.size === 0) throw new Error('模型没有返回任何可对账的条目');
      return parsed;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// ---------------------------------------------------------------- 一轮翻译（含并发去重与状态快照）

export interface TranslationRunnerState {
  inflight: boolean;
  lastRunAt: string | null;
  lastError: string | null;
}

const runners = new Map<string, TranslationRunnerState>();
const inflightRuns = new Map<string, Promise<TranslationPassResult>>();

export function translationRunnerState(dataDir: string): TranslationRunnerState {
  return runners.get(dataDir) ?? { inflight: false, lastRunAt: null, lastError: null };
}

/**
 * 一轮翻译：扫描候选 → 过滤（中文跳过/已翻译跳过/内容变更重译）→ 批量调 LLM → 落库。
 *
 * 「采集后自动触发」与「手动触发」都走这里；`background=true` 时异常只记状态不抛
 * （后台任务不能把调用方拖崩），手动路径用 false 让错误冒泡成 HTTP 语义。
 */
export async function runTranslationPass(
  config: AppConfig,
  deps: TranslateDeps,
  options: { background?: boolean } = {},
): Promise<TranslationPassResult> {
  const empty: TranslationPassResult = {
    requested: 0, translated: 0, skippedCjk: 0, failed: 0, capReached: false, degraded: false, alreadyDone: 0,
  };

  const state = runners.get(config.dataDir) ?? { inflight: false, lastRunAt: null, lastError: null };
  if (state.inflight) {
    const running = inflightRuns.get(config.dataDir);
    return running ?? empty;
  }

  const exec = (async (): Promise<TranslationPassResult> => {
    const now = deps.now ?? new Date();
    const dailyLimit = deps.dailyLimit ?? config.translation.dailyLimit;
    const result: TranslationPassResult = { ...empty };

    // 未配置 → 静默降级：不报错不重试，状态里如实说明
    if (!deps.llm && !isLlmConfigured(config)) {
      result.degraded = true;
      return result;
    }
    const llm: TranslateLlm = deps.llm ?? (await import('../ideas/llm.js')).createLlm(config);

    // 每日上限是硬闸：今天已翻条数先对账
    let remaining = dailyLimit - translationCountToday(deps.db, now);
    if (remaining <= 0) {
      result.capReached = true;
      return result;
    }

    const scanLimit = deps.scanLimit ?? Math.max(remaining * 3, 120);
    const candidates: TranslationCandidate[] = listTranslationCandidates(deps.db, scanLimit);

    const pending: BatchInput[] = [];
    for (const candidate of candidates) {
      if (!needsTranslation(candidate)) {
        // 中文原文（含 CJK）跳过是功能语义，单独计数给状态页看
        if (containsCjk(`${candidate.title}\n${candidate.summary}`)) result.skippedCjk += 1;
        else if (candidate.zhKey !== null) result.alreadyDone += 1;
        continue;
      }
      if (remaining - pending.length <= 0) break;
      pending.push({ id: candidate.id, kind: candidate.kind, title: candidate.title, summary: candidate.summary });
    }
    result.requested = pending.length;
    if (pending.length === 0) return result;

    const batchSize = deps.batchSize ?? BATCH_SIZE;
    const saves: TranslationSave[] = [];
    const translatedAt = now.toISOString();

    for (let start = 0; start < pending.length; start += batchSize) {
      if (result.translated >= remaining || start / batchSize >= MAX_BATCHES_PER_PASS) {
        result.capReached = true;
        break;
      }
      const batch = pending.slice(start, start + batchSize);
      try {
        const answers = await translateBatch(llm, batch, { thinkingDisabled: config.llm.thinkingDisabled });
        for (const item of batch) {
          const answer = answers.get(item.id);
          if (!answer) {
            result.failed += 1;
            continue;
          }
          saves.push({ id: item.id, titleZh: answer.titleZh, summaryZh: answer.summaryZh, translatedAt, zhKey: contentKey(item) });
          result.translated += 1;
        }
      } catch (error) {
        // 整批失败（重试耗尽）：条数记 failed，留给下一轮（zhKey 仍是旧值/缺失）。
        // 手动路径也不抛——HTTP 层拿 result.failed 就能给出可操作反馈；
        // lastError 留给状态端点定位。
        result.failed += batch.length;
        state.lastError = error instanceof Error ? error.message : String(error);
        break;
      }
    }

    const saved = saveTranslations(deps.db, saves);
    // 实际落库数以 UPDATE 命中为准（条目被 TTL 清掉等极端情况少记）
    if (saved !== result.translated) result.translated = saved;
    if (translationCountToday(deps.db, now) >= dailyLimit) result.capReached = true;
    return result;
  })();

  state.inflight = true;
  state.lastRunAt = null;
  runners.set(config.dataDir, state);
  inflightRuns.set(config.dataDir, exec);

  try {
    const result = await exec;
    state.lastRunAt = new Date().toISOString();
    if (!result.degraded && !result.capReached && result.failed === 0) state.lastError = null;
    return result;
  } catch (error) {
    state.lastError = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    state.inflight = false;
    runners.set(config.dataDir, state);
    if (inflightRuns.get(config.dataDir) === exec) inflightRuns.delete(config.dataDir);
  }
}
