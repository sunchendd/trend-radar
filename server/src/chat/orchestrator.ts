/**
 * chat 编排器：决策循环 → 工具执行 → 流式合成。为什么这么设计：
 *
 * 1. **决策与合成拆成两段**：决策轮要严格 JSON（用非流式 + extractJson，抗造），
 *    合成轮要逐字上屏（用 completeStream）。同一个系统提示家族（prompt.ts），
 *    但每段只挂自己需要的契约，模型不容易把「输出 JSON」带进最终回答。
 * 2. **工具反馈以 user 消息回灌**：多轮对话保持纯 messages 数组，不引入任何
 *    私有协议，任何 OpenAI 兼容端点都能跑。
 * 3. **证据统一编号**：每个工具结果的条目按 url 去重后进 citations，序号即 [n]，
 *    与 SSE sources 事件、合成提示里的证据清单完全同源——模型引用的编号、
 *    前端展示的来源、可回溯的证据三者一致。
 * 4. **中断检查在轮与轮之间**：客户端断开（AbortSignal）在每轮开始和合成前检查，
 *    合成流本身把 signal 透传给 completeStream 随时掐断。
 */

import { randomUUID } from 'node:crypto';

import type { GenerateIdeasRequest, Idea, Item, ItemQuery, NoveltyRecord, Paged, Source, Stats } from '../types.js';
import type { VerdictSummary } from '../ideas/verdict.js';
import type { Watch } from '../store/watches.js';
import type { LlmClient, ChatMessage } from '../ideas/llm.js';
import { extractJson } from '../ideas/llm.js';
import { badGateway } from '../http/errors.js';
import { buildComposePrompt, buildDecisionPrompt, serializeEvidence, serializeToolResult } from './prompt.js';
import { runTool, type FetchLike, type ToolContext } from './tools.js';
import type { ChatAction, ChatEvents, ChatHistoryMessage, ChatOutcome, ChatSourceItem, ChatStep, ChatToolName, ChatTurn } from './types.js';

/** 最多几轮工具调用；超过直接进入合成（强制 final） */
export const MAX_TOOL_ROUNDS = 4;

/** 编排器需要的下层能力（结构化类型，测试按需实现） */
export interface ChatDeps {
  llm: LlmClient;
  listItems(query: ItemQuery): Paged<Item>;
  listSources(): Source[];
  stats(): Stats;
  listWatches(includeDisabled?: boolean): Watch[];
  generateIdeas(req: GenerateIdeasRequest): Promise<{ ideas: Idea[] }>;
  /** 实时检索（arXiv / Google Patents）用的 fetch；默认全局 fetch */
  fetch?: FetchLike;
  now?: () => Date;
  /** 选题读取（export_disclosure / check_novelty / draft_claims 用） */
  getIdea(ideaId: string): Idea | undefined;
  /** 查新闭环：智慧芽 CLI 可用时跑真查新并落库 */
  autoNovelty?(ideaId: string): Promise<Idea>;
  summarizeVerdict?(records: NoveltyRecord[]): VerdictSummary;
  /** settings.novelty.hasCommand：CLI 命令非空且真实存在 */
  noveltyCommandAvailable?: boolean;
  /** 权利要求草案落库（chat-store 的 idea_claims） */
  saveClaims(ideaId: string, content: string, at?: string): void;
}

export interface RunChatOptions {
  /** 客户端断开信号：轮间检查 + 透传给合成流 */
  signal?: AbortSignal;
}

/** 各阶段给用户看的中文进度文案（SSE status 事件的 label） */
const STATUS_LABELS: Record<ChatStep, string> = {
  plan: '正在分析问题…',
  search_local: '正在检索库内情报…',
  search_arxiv: '正在实时检索 arXiv…',
  search_patents: '正在检索 Google Patents…',
  generate_ideas: '生成选题约需 1-2 分钟，正在生成…',
  export_disclosure: '正在导出交底书…',
  check_novelty: '正在跑查新判读（约 20-60 秒）…',
  draft_claims: '正在起草权利要求…',
  compose: '正在组织回答…',
};

const TOOL_ACTIONS: readonly string[] = [
  'search_local',
  'search_arxiv',
  'search_patents',
  'generate_ideas',
  'export_disclosure',
  'check_novelty',
  'draft_claims',
];

function dateLabelOf(now: Date): string {
  return `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;
}

/**
 * 解析决策轮输出。容错策略：
 * - JSON 解析失败 → 502 llm_bad_output（模型连契约都守不住，重试由用户发起）；
 * - action 未知 → 按 final 处理（至少还能合成一次回答，好过直接失败）；
 * - args 缺失/不是对象 → 空对象（工具自己会对缺参给出 note）。
 */
function parseDecision(text: string): { thought: string; action: ChatAction; args: Record<string, unknown> } {
  let raw: unknown;
  try {
    raw = extractJson(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw badGateway('llm_bad_output', `模型决策输出无法解析为 JSON：${reason}`);
  }
  const obj = (raw ?? {}) as Record<string, unknown>;
  const actionText = typeof obj['action'] === 'string' ? obj['action'].trim() : '';
  const action = (actionText === 'final' || TOOL_ACTIONS.includes(actionText) ? actionText : 'final') as ChatAction;
  const args =
    obj['args'] !== null && typeof obj['args'] === 'object' && !Array.isArray(obj['args'])
      ? (obj['args'] as Record<string, unknown>)
      : {};
  return { thought: typeof obj['thought'] === 'string' ? obj['thought'] : '', action, args };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('对话已被客户端取消', 'AbortError');
}

/**
 * 跑一次完整对话。回调经 events 上报（status/sources/token），最终返回
 * messageId/toolsUsed/answer——routes.ts 用返回值发 done 帧。
 */
export async function runChat(
  deps: ChatDeps,
  turn: ChatTurn,
  events: ChatEvents,
  options: RunChatOptions = {},
): Promise<ChatOutcome> {
  const signal = options.signal;
  const now = deps.now ?? (() => new Date());

  const stats = deps.stats();
  const promptCtx = {
    dateLabel: dateLabelOf(now()),
    itemCount: stats.items,
    ideaCount: stats.ideas,
    watchCount: deps.listWatches(true).length,
    enabledSources: deps.listSources().filter((source) => source.enabled).map((source) => source.label),
  };

  throwIfAborted(signal);
  events.status('plan', STATUS_LABELS['plan']);

  const history: ChatMessage[] = turn.history.map((entry: ChatHistoryMessage) => ({ role: entry.role, content: entry.content }));

  // 证据收集：按 url 去重（选题没有 url，退回 idea:<id>），序号即 [n] 引用编号
  const citations: ChatSourceItem[] = [];
  const seenCitations = new Set<string>();
  const collectCitations = (items: ChatSourceItem[]): void => {
    for (const item of items) {
      const key = item.url !== '' ? item.url : `idea:${String(item.meta['id'] ?? item.title)}`;
      if (seenCitations.has(key)) continue;
      seenCitations.add(key);
      citations.push(item);
    }
    events.sources([...citations]);
  };

  const toolCtx: ToolContext = {
    fetch: deps.fetch ?? ((input, init) => fetch(input, init)),
    listItems: deps.listItems,
    generateIdeas: deps.generateIdeas,
    now,
    getIdea: deps.getIdea,
    autoNovelty: deps.autoNovelty,
    summarizeVerdict: deps.summarizeVerdict,
    noveltyCommandAvailable: deps.noveltyCommandAvailable,
    saveClaims: deps.saveClaims,
    // 权利要求起草复用当前对话的 LLM 通道
    llm: deps.llm,
  };

  const feedback: ChatMessage[] = [];
  const toolsUsed: ChatToolName[] = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    throwIfAborted(signal);
    const decisionMessages: ChatMessage[] = [
      { role: 'system', content: buildDecisionPrompt(promptCtx) },
      ...history,
      { role: 'user', content: turn.message },
      ...feedback,
    ];
    const decisionText = await deps.llm.complete(decisionMessages, { temperature: 0.2 });
    const decision = parseDecision(decisionText);
    if (decision.action === 'final') break;

    events.status(decision.action, STATUS_LABELS[decision.action]);
    const result = await runTool(toolCtx, decision.action, decision.args);
    collectCitations(result.items);
    toolsUsed.push(decision.action);
    feedback.push({ role: 'user', content: serializeToolResult(decision.action, result) });
  }
  // 循环耗尽（4 轮全是工具）＝ 强制 final，直接落入合成，不再多问一轮模型

  throwIfAborted(signal);
  events.status('compose', STATUS_LABELS['compose']);
  const composeMessages: ChatMessage[] = [
    { role: 'system', content: buildComposePrompt(promptCtx) },
    ...history,
    { role: 'user', content: turn.message },
    ...feedback,
    ...(citations.length > 0 ? [{ role: 'user' as const, content: serializeEvidence(citations) }] : []),
  ];
  const answer = await deps.llm.completeStream(composeMessages, { signal }, (delta) => events.token(delta));

  return {
    messageId: `chat-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
    toolsUsed,
    answer,
  };
}
