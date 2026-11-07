/**
 * release 技术点抽取（t21）：把 GitHub release note 变成结构化中文要点。
 *
 * 双路径：
 *  - **LLM 路径**（配置了 LLM 时优先）：把 release note（markdown）整段交给模型，
 *    要求输出结构化 JSON {points:[{category,zh}], summaryZh}，并优先提炼
 *    「相对上一版**新增/变化**」的改动（New Features / What's Changed 的语义）；
 *  - **规则兜底**（无 LLM 也能用）：解析 Features / Bug Fixes / Changes 等
 *    section + 关键词归类（scheduler/KV cache/speculative/quantization/kernel/
 *    parallelism/H100/FP8…），保证无 LLM 也有可用产出。规则路径不消耗 LLM 配额。
 *
 * 配额与异步管线与 t18 翻译共用：同一 dailyLimit 池（翻译 + 抽取合计），
 * 同一「采集后异步触发 + 手动/页面懒触发」的形状。
 * 幂等：points_key = 内容指纹（release 正文变了才重抽）；同版本不重抽。
 */

import { createHash } from 'node:crypto';

import type { AppConfig } from '../config.js';
import type { DatabaseSync } from 'node:sqlite';
import { extractJson, isLlmConfigured } from '../ideas/llm.js';
import {
  extractionCountToday,
  listExtractionCandidates,
  saveExtractions,
  translationCountToday,
  type ExtractionCandidate,
  type ExtractionSave,
} from '../store/queries.js';
import type { TechCategory, TechPoint } from '../types.js';
import { translationRunnerState } from '../translation/translate.js';

export const CATEGORIES: readonly TechCategory[] = ['调度', 'KV', '投机', '量化', '算子', '并行', '硬件', '其他'];
/** 抽取批次：release note 大（几 KB），一批 3 条稳妥 */
export const BATCH_SIZE = 3;
const NOTE_INPUT_LIMIT = 6000;
const MAX_BATCHES_PER_PASS = 40;

/** 抽取时的内容指纹：release 正文变了 → key 对不上 → 重抽 */
export function pointsKey(item: { title: string; summary?: string; note?: string }): string {
  return createHash('sha1').update(`${item.title}\n${item.summary ?? item.note ?? ''}`, 'utf8').digest('hex').slice(0, 16);
}

/** 该 release 是否需要（重）抽取：无点数或指纹不一致 */
export function needsExtraction(item: {
  title: string;
  summary: string;
  pointsKey?: string | null;
}): boolean {
  if (item.summary.trim() === '') return false;
  return item.pointsKey !== pointsKey(item);
}

// ---------------------------------------------------------------- 规则兜底

/** 关键词 → 分类（第一个命中的规则生效；顺序即优先级） */
const RULES: { category: TechCategory; patterns: RegExp }[] = [
  { category: '调度', patterns: /scheduler|schedul|prefill|decode|batching|disagg|pd.?split|prefill-decode|load balanc|router|cache.?aware/i },
  { category: 'KV', patterns: /kv.?cache|pagedattention|radix|prefix cache|block.?size|kv (?:reuse|offload|eviction)/i },
  { category: '投机', patterns: /speculative|draft model|mtp|eagle|medusa|lookahead|ngram/i },
  { category: '量化', patterns: /quant(?:ization|ize|ized)?|fp8|fp4|int8|int4|awq|gptq|nvfp4|w8a8|weight.?only/i },
  { category: '算子', patterns: /kernel|attention impl|flashinfer|triton|cuda graph|fused|op\b|operator|rope|moe|cutlass/i },
  { category: '并行', patterns: /parallelism|tensor.?par|pipeline.?par|expert.?par|tp\b|pp\b|ep\b|dp\b|all.?reduce|nccl|multi-?gpu|world size/i },
  { category: '硬件', patterns: /h100|h200|h800|a100|blackwell|hopper|lovelace|gb200|b200|4090|a3|vram|npu|ascend|mi300|rocm|sm\d0|compute capability/i },
];

const SECTION_HEAD = /^(?:#{1,4}\s*)?(?:features|new features|what'?s changed|what'?s new|changes|highlights|improvements|notable changes|bug fixes|key changes)\b/im;

function categoryOf(text: string): TechCategory {
  for (const rule of RULES) if (rule.patterns.test(text)) return rule.category;
  return '其他';
}

/** 取要点句子：把 markdown 剥成行，挑信息密度最高的一行压成一句话 */
function condense(line: string): string {
  return line
    .replace(/^[-*+\s]*\[[x ]\]\s*/i, '')
    .replace(/^#{1,6}\s*/, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s*\(#[\d]+\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * 规则兜底抽取：优先 Features/Changes 等 section 的 bullet 行（跨 section 收集，
 * 直到收集够 4 条再遇大标题才停）；没有 section 时用关键词在全文里捞命中的行。
 * 最多 6 条，每条压成一句话，并归类。
 */
export function ruleExtract(title: string, note: string): TechPoint[] {
  const text = note.length > NOTE_INPUT_LIMIT ? note.slice(0, NOTE_INPUT_LIMIT) : note;
  const rawLines = text.split('\n');
  // 行必须按下标配对（标题判定在 raw 上、取词在 condense 后的行上）：
  // 中途 filter 会让索引错位、把 section 边界读错
  const lines = rawLines.map(condense);

  const picked: string[] = [];
  let started = false;
  for (let i = 0; i < rawLines.length && picked.length < 8; i += 1) {
    const raw = rawLines[i] ?? '';
    const line = lines[i] ?? '';
    if (/^#{1,6}\s/.test(raw)) {
      // markdown 大标题：进 section 前只标记 started；收集够 4 条后再遇标题就收工
      if (started && picked.length >= 4) break;
      if (!started && SECTION_HEAD.test(line) && line.length < 60) started = true;
      continue;
    }
    if (!started) continue;
    if (line.length < 8) continue;
    if (/^(?:bug fixes|features|new features|changes|highlights|improvements|notable changes|key changes|what'?s changed|what'?s new)\b.*$/i.test(line) && line.length < 60) continue;
    picked.push(line);
  }
  if (picked.length === 0) {
    picked.push(...lines.filter((line) => RULES.some((rule) => rule.patterns.test(line))));
  }
  for (const line of [...picked]) {
    if (/^#/.test(line) || /^(?:prerelease|full changelog|don'?t miss)/i.test(line)) {
      picked.splice(picked.indexOf(line), 1);
    }
  }

  const points: TechPoint[] = [];
  const seen = new Set<string>();
  for (const line of picked) {
    if (points.length >= 6) break;
    if (seen.has(line)) continue;
    seen.add(line);
    const zh = line.length > 60 ? `${line.slice(0, 58)}…` : line;
    points.push({ category: categoryOf(line), zh });
  }
  // release title 本身往往就是版本主题（tag 行没有正文 section 时兜底）
  if (points.length === 0 && title.trim().length >= 4) {
    points.push({ category: categoryOf(`${title} ${text.slice(0, 400)}`), zh: condense(title) });
  }
  return points;
}

function normalizeCategory(raw: unknown): TechCategory {
  const text = typeof raw === 'string' ? raw.trim() : '';
  const hit = CATEGORIES.find((c) => text.includes(c) || (c === 'KV' && /kv/i.test(text)) || (c === '硬件' && /hardware/i.test(text)));
  return hit ?? '其他';
}

// ---------------------------------------------------------------- LLM 路径

const SYSTEM_PROMPT = [
  '你是 GPU 推理引擎的 release note 分析引擎。输入一个 GitHub release 的标题与正文（markdown）。',
  '输出一个 JSON 对象：{"points":[{"category":"调度|KV|投机|量化|算子|并行|硬件|其他","zh":"一句话中文要点"}],"summaryZh":"两句话中文版本摘要"}。',
  '要求：',
  '1. 只输出 JSON 本体，不要解释或 markdown 围栏；',
  '2. category 只能取：调度、KV、投机、量化、算子、并行、硬件、其他；',
  '3. 优先提炼「相对上一版**新增/变化**」的改动（What\'s Changed / New Features 的语义），跳过纯文档/CI 更新；',
  '4. zh 是给工程师看的一句话要点（≤40 字），保留关键术语英文（如 speculative decoding、FP8）；',
  '5. 最多 6 条，按重要性排序。',
].join('\n');

interface LlmExtract {
  points: TechPoint[];
  summaryZh?: string;
}

async function llmExtractBatch(
  llm: { complete(messages: { role: 'system' | 'user' | 'assistant'; content: string }[], options?: { temperature?: number; maxTokens?: number; timeoutMs?: number; thinking?: 'disabled' | 'enabled' }): Promise<string> },
  batch: { id: string; title: string; note: string }[],
  options: { thinkingDisabled?: boolean } = {},
): Promise<Map<string, LlmExtract>> {
  const items = batch.map((item) => ({
    id: item.id,
    title: item.title,
    note: item.note.length > NOTE_INPUT_LIMIT ? `${item.note.slice(0, NOTE_INPUT_LIMIT)}…` : item.note,
  }));
  const user = `分析以下 ${batch.length} 个 release：\n[${items.map((i) => JSON.stringify(i)).join(',\n')}]`;
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= 1; attempt += 1) {
    try {
      const answer = await llm.complete(
        [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: user + (attempt > 0 ? '\n\n注意：只输出 JSON 对象本体。' : '') },
        ],
        {
          temperature: 0.2,
          maxTokens: Math.min(8000, 600 + batch.length * 700),
          timeoutMs: 90_000,
          // t24：抽取同翻译一样关思考（机械任务省 token；TREND_LLM_THINKING_DISABLED=0 可关）
          thinking: options.thinkingDisabled === true ? 'disabled' : undefined,
        },
      );
      const parsed = extractJson(answer) as { points?: unknown; summaryZh?: unknown };
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.points)) throw new Error('模型输出缺少 points 数组');
      const out = new Map<string, LlmExtract>();
      const points = (parsed.points as { category?: unknown; zh?: unknown }[])
        .map((p) => ({ category: normalizeCategory(p.category), zh: typeof p.zh === 'string' ? p.zh.trim() : '' }))
        .filter((p) => p.zh !== '')
        .slice(0, 6);
      for (const item of batch) {
        if (points.length === 0) continue;
        out.set(item.id, {
          points,
          summaryZh: typeof parsed.summaryZh === 'string' ? parsed.summaryZh.trim() : undefined,
        });
      }
      if (out.size === 0) throw new Error('模型没有给出可用的技术点');
      return out;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// ---------------------------------------------------------------- 一轮抽取

export interface ExtractDeps {
  db: DatabaseSync;
  /** LLM 客户端；undefined = 规则兜底路径 */
  llm?: {
    complete(messages: { role: 'system' | 'user' | 'assistant'; content: string }[], options?: { temperature?: number; maxTokens?: number; timeoutMs?: number }): Promise<string>;
  };
  now?: Date;
  batchSize?: number;
  dailyLimit?: number;
  scanLimit?: number;
  /** 关闭规则兜底（测试用：断言 LLM 路径独立行为） */
  disableRules?: boolean;
}

export interface ExtractionPassResult {
  requested: number;
  extracted: number;
  viaLlm: number;
  viaRules: number;
  failed: number;
  capReached: boolean;
  degraded: boolean;
}

export interface ExtractionRunnerState {
  inflight: boolean;
  lastRunAt: string | null;
  lastError: string | null;
}

const runners = new Map<string, ExtractionRunnerState>();
const inflightRuns = new Map<string, Promise<ExtractionPassResult>>();

export function extractionRunnerState(dataDir: string): ExtractionRunnerState {
  return runners.get(dataDir) ?? { inflight: false, lastRunAt: null, lastError: null };
}

/**
 * 一轮抽取：候选扫描 →（LLM 配置时 LLM 路径，否则规则兜底）→ 落库。
 * 配额只约束 **LLM 路径**（规则是本地计算零成本）；LLM 配额池与翻译共用：
 * used = translationCountToday + extractionCountToday（LLM 抽取的条数）。
 */
export async function runExtractionPass(
  config: AppConfig,
  deps: ExtractDeps,
  options: { background?: boolean } = {},
): Promise<ExtractionPassResult> {
  const state = runners.get(config.dataDir) ?? { inflight: false, lastRunAt: null, lastError: null };
  if (state.inflight) {
    const running = inflightRuns.get(config.dataDir);
    return running ?? { requested: 0, extracted: 0, viaLlm: 0, viaRules: 0, failed: 0, capReached: false, degraded: false };
  }

  const exec = (async (): Promise<ExtractionPassResult> => {
    const now = deps.now ?? new Date();
    const result: ExtractionPassResult = { requested: 0, extracted: 0, viaLlm: 0, viaRules: 0, failed: 0, capReached: false, degraded: false };
    const useLlm = deps.llm !== undefined || isLlmConfigured(config);
    if (!useLlm && deps.disableRules === true) {
      result.degraded = true;
      return result;
    }
    const llm = useLlm ? deps.llm : undefined;

    const dailyLimit = deps.dailyLimit ?? config.translation.dailyLimit;
    // 共享池：翻译 + LLM 抽取今日合计
    let remaining = Math.max(0, dailyLimit - (translationCountToday(deps.db, now) + extractionCountToday(deps.db, now)));

    const scanLimit = deps.scanLimit ?? Math.max(remaining * 3, 120);
    const candidates: ExtractionCandidate[] = listExtractionCandidates(deps.db, scanLimit);
    const pending = candidates.filter((candidate) => {
      if (!needsExtraction(candidate)) return false;
      if (useLlm && remaining <= 0) return false;
      return true;
    });
    result.requested = pending.length;
    if (pending.length === 0) return result;

    const batchSize = deps.batchSize ?? BATCH_SIZE;
    const saves: ExtractionSave[] = [];
    const extractedAt = now.toISOString();

    for (let start = 0; start < pending.length; start += batchSize) {
      if (start / batchSize >= MAX_BATCHES_PER_PASS) {
        result.capReached = true;
        break;
      }
      const batch = pending.slice(start, start + batchSize).map((candidate) => ({
        id: candidate.id,
        title: candidate.title,
        note: candidate.summary,
      }));

      if (llm !== undefined) {
        // LLM 路径：受共享配额约束（逐条计账；配额用尽后同批剩余条目走规则兜底）
        if (remaining <= 0) {
          result.capReached = true;
          break;
        }
        try {
          const answers = await llmExtractBatch(llm, batch, { thinkingDisabled: config.llm.thinkingDisabled });
          for (const item of batch) {
            const answer = answers.get(item.id);
            const canUseLlm = answer !== undefined && remaining > 0;
            if (canUseLlm) {
              saves.push({ id: item.id, pointsZh: answer.points, pointsAt: extractedAt, pointsKey: pointsKey(item) });
              result.extracted += 1;
              result.viaLlm += 1;
              remaining -= 1;
              continue;
            }
            // LLM 没给该条 / 配额刚好用尽 → 规则兜底这一条（不占 LLM 配额）
            if (deps.disableRules !== true) {
              const points = ruleExtract(item.title, item.note);
              if (points.length > 0) {
                saves.push({ id: item.id, pointsZh: points, pointsAt: extractedAt, pointsKey: pointsKey(item) });
                result.extracted += 1;
                result.viaRules += 1;
                continue;
              }
            }
            if (answer === undefined) result.failed += 1;
          }
          if (remaining <= 0) result.capReached = true;
        } catch (error) {
          // 整批 LLM 失败 → 全批规则兜底（无 LLM 也要有产出）
          state.lastError = error instanceof Error ? error.message : String(error);
          for (const item of batch) {
            if (deps.disableRules === true) {
              result.failed += 1;
              continue;
            }
            const points = ruleExtract(item.title, item.note);
            if (points.length === 0) {
              result.failed += 1;
              continue;
            }
            saves.push({ id: item.id, pointsZh: points, pointsAt: extractedAt, pointsKey: pointsKey(item) });
            result.extracted += 1;
            result.viaRules += 1;
          }
        }
      } else {
        // 规则兜底路径：零成本、不受配额限制
        for (const item of batch) {
          const points = ruleExtract(item.title, item.note);
          if (points.length === 0) {
            result.failed += 1;
            continue;
          }
          saves.push({ id: item.id, pointsZh: points, pointsAt: extractedAt, pointsKey: pointsKey(item) });
          result.extracted += 1;
          result.viaRules += 1;
        }
      }
    }

    const saved = saveExtractions(deps.db, saves);
    if (saved !== result.extracted) result.extracted = saved;
    // 配额对账：LLM 路径用完（翻译+抽取今日合计 ≥ 上限）即标记，前端据此显示额度状态
    if (useLlm && translationCountToday(deps.db, now) + extractionCountToday(deps.db, now) >= dailyLimit) {
      result.capReached = true;
    }
    return result;
  })();

  state.inflight = true;
  runners.set(config.dataDir, state);
  inflightRuns.set(config.dataDir, exec);

  try {
    const result = await exec;
    state.lastRunAt = new Date().toISOString();
    if (result.failed === 0) state.lastError = null;
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

/** 翻译运行器状态引用：抽取与翻译串行排队时状态页可以看到两边（当前实现各自独立） */
export function translationInflightOf(dataDir: string): boolean {
  return translationRunnerState(dataDir).inflight;
}
