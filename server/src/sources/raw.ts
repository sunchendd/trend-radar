import type { ItemKind } from '../types.js';
import { itemId } from '../url.js';

/**
 * 抓取层的中间产物。
 *
 * 为什么不直接用 types.Item：Item 要求 score/scoreReasons/fetchedAt，这些是「打分」和
 * 「入库」两步的产物。抓取层不该知道打分规则，否则改权重就要动解析器。
 */
export interface RawItem {
  /** 去重键 itemId(sourceId, url) */
  id: string;
  sourceId: string;
  kind: ItemKind;
  title: string;
  url: string;
  summary: string;
  authors: string[];
  /** ISO 时间；原始源没给就退化为抓取时刻（契约允许） */
  publishedAt: string;
  /** arXiv id / DOI / GitHub release tag，用于跨源去重 */
  externalId?: string;
}

const ARXIV_NEW = /arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})(?:v\d+)?/i;
const ARXIV_OLD = /arxiv\.org\/(?:abs|pdf)\/([a-z-]+(?:\.[a-z]{2})?\/\d{7})(?:v\d+)?/i;
const DOI = /\b(10\.\d{4,9}\/[^\s"'<>()\[\]]+)/;
const GITHUB_RELEASE_TAG = /github\.com\/([^/\s]+)\/([^/\s]+)\/releases\/tag\/([^?#\s]+)/i;

/**
 * 抽出跨源主键。
 *
 * 优先级 arXiv id > DOI > GitHub tag：
 * 同一篇论文常同时出现在 arXiv 订阅和厂商 blog 里，它们的 url 完全不同，
 * 只有 arXiv id 能把两条串起来；DOI 次之（正式发表版本）；GitHub tag 用来
 * 合并「releases.atom」与「blog 里提到同一个 release」。
 * 版本号 vN 一律去掉：v1/v2 是同一篇。
 */
export function extractExternalId(url: string, text = ''): string | undefined {
  const arxivNew = ARXIV_NEW.exec(url) ?? ARXIV_NEW.exec(text);
  if (arxivNew?.[1]) return arxivNew[1];
  const arxivOld = ARXIV_OLD.exec(url) ?? ARXIV_OLD.exec(text);
  if (arxivOld?.[1]) return arxivOld[1].toLowerCase();

  const gh = GITHUB_RELEASE_TAG.exec(url);
  if (gh?.[1] && gh[2] && gh[3]) return `gh:${gh[1]}/${gh[2]}@${decodeURIComponent(gh[3])}`;

  const doi = DOI.exec(text);
  if (doi?.[1]) return doi[1].replace(/[.,;:]+$/, '').toLowerCase();

  return undefined;
}

/** 时间统一成 ISO；解析不出来就退到 fallback（抓取时刻），保证 publishedAt 永不为空 */
export function toIsoString(raw: string | undefined, fallback: Date): string {
  const trimmed = raw?.trim();
  if (trimmed) {
    const ms = Date.parse(trimmed);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return fallback.toISOString();
}

/** 摘要截断：库里只留够前端展示与关键词匹配的长度，完整内容在原文链接里 */
export function clampText(input: string, max = 1200): string {
  const text = input.trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export interface RawItemDraft {
  sourceId: string;
  kind: ItemKind;
  title: string;
  url: string;
  summary: string;
  authors: string[];
  publishedAt: string;
  externalId?: string;
}

/** 收口构造：统一算去重键、统一截断，避免各解析器各写一套 */
export function makeRawItem(draft: RawItemDraft): RawItem {
  const item: RawItem = {
    id: itemId(draft.sourceId, draft.url),
    sourceId: draft.sourceId,
    kind: draft.kind,
    title: clampText(draft.title, 300),
    url: draft.url,
    summary: clampText(draft.summary),
    authors: draft.authors.slice(0, 12),
    publishedAt: draft.publishedAt,
  };
  if (draft.externalId) item.externalId = draft.externalId;
  return item;
}
