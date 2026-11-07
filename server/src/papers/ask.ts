/**
 * 论文阅读器「选中文本提问」：把当前页文本 + 选中文本作为上下文，LLM 流式作答。
 *
 * 与 chat 编排器的分工：chat 是「全库检索 + 工具循环」，这里的提问永远只需要
 * 「眼前这一页」，一次直连 LLM 就够——不多轮、不检索、不落库（会话历史由前端持有）。
 * SSE 帧契约与 /api/chat 完全同构（status/token/done/error），前端可以复用同一套解析。
 */
import type { LlmClient } from '../ideas/llm.js';

export interface PaperAskContext {
  /** 论文标题 */
  title: string;
  /** 入库摘要（abs 段），可为空 */
  abstract: string;
  /** 用户当前页码（1 起） */
  page: number;
  /** 当前页全文（前端 pdf.js 文本层提取） */
  pageText: string;
  /** 用户选中的文本（提问焦点） */
  selection: string;
}

export interface PaperAskMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface PaperAskHandlers {
  token: (text: string) => void;
}

/** 上下文上限：单页文本最多 ~12k 字符，防止个别扫描页撑爆请求体 */
const PAGE_TEXT_LIMIT = 12_000;
const SELECTION_LIMIT = 4_000;
const HISTORY_LIMIT = 8;

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…（已截断）` : trimmed;
}

export function buildPaperAskMessages(
  ctx: PaperAskContext,
  history: PaperAskMessage[],
): { role: 'system' | 'user' | 'assistant'; content: string }[] {
  const pageText = clip(ctx.pageText, PAGE_TEXT_LIMIT);
  const selection = clip(ctx.selection, SELECTION_LIMIT);

  const contextLines = [
    `论文标题：${ctx.title}`,
    ctx.abstract ? `论文摘要：${clip(ctx.abstract, 2_000)}` : '',
    `当前阅读页码：第 ${ctx.page} 页`,
    pageText ? `当前页全文：\n<page>\n${pageText}\n</page>` : '当前页全文：（未能提取到本页文本）',
    selection ? `用户选中的文本：\n<selection>\n${selection}\n</selection>` : '',
  ].filter((line) => line !== '');

  const historyMessages = history.slice(-HISTORY_LIMIT).map((m) => ({
    role: m.role,
    content: clip(m.content, 4_000),
  }));

  return [
    {
      role: 'system',
      content: [
        '你是论文精读助手。用户正在看板里阅读论文 PDF，会针对当前页或选中文本提问。',
        '要求：',
        '1. 只依据给出的论文上下文（标题/摘要/当前页文本/选中文本）和常识性领域知识回答；',
        '2. 引用原文时保持原句精确，可以翻译解释；上下文不足以回答时明确说「当前页没有涉及」，不要编造；',
        '3. 回答用中文，简洁、结论先行；涉及公式/方法名时保留英文原文；',
        '4. 用户在写专利选题的工作流里，可以顺带点出技术要点，但不主动扩写专利内容，除非被问到。',
      ].join('\n'),
    },
    ...historyMessages,
    { role: 'user', content: `${contextLines.join('\n\n')}\n\n用户的问题：` },
  ];
}

/**
 * 执行一次论文问答：流式 token 回调，返回完整回答文本。
 * 抛出的异常由 HTTP 层统一翻译（LLM 未配置 → 503 等）。
 */
export async function runPaperAsk(
  llm: LlmClient,
  ctx: PaperAskContext,
  history: PaperAskMessage[],
  handlers: PaperAskHandlers,
  options: { signal?: AbortSignal } = {},
): Promise<{ answer: string }> {
  const messages = buildPaperAskMessages(ctx, history);
  const answer = await llm.completeStream(
    messages,
    { temperature: 0.3, maxTokens: 4000, signal: options.signal },
    (delta) => handlers.token(delta),
  );
  return { answer };
}
