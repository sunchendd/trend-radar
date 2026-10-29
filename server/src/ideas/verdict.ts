/**
 * 查新判读：由命中数**机械**推出结论。纯函数，无 IO，可单测。
 *
 * 这个文件存在的唯一理由，是生产上踩过的那次坑：
 * 三条检索式全零，被判成「技术空白（gap）」并写进了选题库。
 * 实际原因是检索式 6 个词、智慧芽简单搜索是 AND 语义，词多即空。
 * 所以这里的规则是反直觉的：**全零不算空白，算无效**。
 *
 * 四档的语义边界：
 *   - 红海（任一检索式 ≥50 命中）：这个方向已经有成建制布防，规避成本高；
 *   - 机会（1–5 命中的稀疏交叉带，且无红海检索式）：两三个技术手段交叉处
 *     只有零星专利，是最值得读权利要求的位置；
 *   - 机会（仅 6–49 的中间值）：密度中等，光看数字判不了，必须读最近邻权利要求；
 *   - 无效（全部解析失败 / 全部为 0）：没有证据，不是「空白证据」。
 *
 * 注意：`gap`（确信的技术空白）**没有机械出口**。它只能由人读完权利要求后
 * 手工确认，函数永远不会返回 gap——历史证明自动判 gap 的代价是误导整条产线。
 */

import type { IdeaStatus, NoveltyRecord, NoveltyVerdict } from '../types.js';
import { synonymRewrites } from './prompts.js';

export interface VerdictOutcome {
  verdict: NoveltyVerdict;
  /** 给前端直接展示的中文理由，必须带关键数字，禁止空话 */
  reason: string;
  /** 建议写回的选题状态 */
  status: IdeaStatus;
}

/** 红海阈值：单条检索式命中 ≥50 视为已形成专利壁垒。 */
export const RED_OCEAN_HITS = 50;
/** 稀疏交叉带上界：1–5 命中是「值得读权利要求」的窗口。 */
export const SPARSE_HITS_MAX = 5;

/** verdict → Idea.status 的映射（两端语义不同，别混用）。 */
export function statusOf(verdict: NoveltyVerdict): IdeaStatus {
  switch (verdict) {
    case 'red-ocean':
      return 'red-ocean';
    case 'opportunity':
    case 'gap':
      return 'verified';
    case 'inconclusive':
    default:
      return 'draft';
  }
}

const fmtHits = (value: number | null): string => (value === null ? 'null' : String(value));

/** `[0, 3, 12]` 这种紧凑形式，reason 里直接给数字，前端不用二次加工。 */
const fmtCounts = (records: NoveltyRecord[]): string =>
  `[${records.map((r) => fmtHits(r.hits)).join(', ')}]`;

const appsOf = (record: NoveltyRecord): string => (record.topAssignees.trim() === '' ? '未取到' : record.topAssignees.trim());

export function verdict(records: NoveltyRecord[]): VerdictOutcome {
  const list = Array.isArray(records) ? records.filter((r): r is NoveltyRecord => Boolean(r)) : [];

  // 没有记录 ≠ 没有专利。没查就是没查，只能回到 draft。
  if (list.length === 0) {
    return {
      verdict: 'inconclusive',
      reason: '尚无查新记录（0 条检索式），无法判读：请先跑智慧芽检索或手工登记命中数',
      status: statusOf('inconclusive'),
    };
  }

  const parsed = list.filter((r) => r.hits !== null);
  const unparsed = list.length - parsed.length;

  // hits === null 是页面解析失败，和 0 命中是两件事（契约里写死了，别合并）
  if (parsed.length === 0) {
    return {
      verdict: 'inconclusive',
      reason: `全部 ${list.length} 条检索式都没取到命中数（页面解析失败，命中数 ${fmtCounts(list)}），本次查新无效：先确认登录态与页面渲染时间再重跑，不能当作无命中`,
      status: statusOf('inconclusive'),
    };
  }

  const counts = parsed.map((r) => r.hits as number);
  const suffix = unparsed > 0 ? `；另有 ${unparsed} 条检索未取到命中数，未计入判读` : '';

  // 全零：最容易被糊弄的地方。先怀疑检索式，再谈空白。
  if (counts.every((n) => n === 0)) {
    return {
      verdict: 'inconclusive',
      reason:
        `全部 ${parsed.length} 条检索式零命中（命中数 ${fmtCounts(parsed)}）：先怀疑检索式/术语，再谈空白` +
        '（简单搜索是 AND 语义，词多即空）；请先减词或换同义词重跑，不得据此判定技术空白' +
        suffix,
      status: statusOf('inconclusive'),
    };
  }

  const reds = parsed.filter((r) => (r.hits as number) >= RED_OCEAN_HITS);
  if (reds.length > 0) {
    // 取命中最多的那条作为代表：红海程度由最强证据说话
    const top = reds.reduce((best, cur) => ((cur.hits as number) > (best.hits as number) ? cur : best));
    return {
      verdict: 'red-ocean',
      reason:
        `存在红海检索式：检索式「${top.query}」命中 ${top.hits}（阈值 ${RED_OCEAN_HITS}），` +
        `头部申请人 ${appsOf(top)}；全批命中数 ${fmtCounts(parsed)}，规避成本高，需换子问题切口` +
        suffix,
      status: statusOf('red-ocean'),
    };
  }

  const sparse = parsed.filter((r) => (r.hits as number) >= 1 && (r.hits as number) <= SPARSE_HITS_MAX);
  if (sparse.length > 0) {
    const first = sparse[0]!;
    return {
      verdict: 'opportunity',
      reason:
        `稀疏交叉带：检索式「${first.query}」命中 ${first.hits}（1–${SPARSE_HITS_MAX} 区间），` +
        `头部申请人 ${appsOf(first)}；全批命中数 ${fmtCounts(parsed)}，属可切入的机会窗口，` +
        '下一步读这几篇最近邻的权利要求确认区别技术特征' +
        suffix,
      status: statusOf('opportunity'),
    };
  }

  // 只剩 6–49 的中间值：数字本身说明不了问题，必须读权利要求
  // 用非零命中算区间：重试后可能有一条检索式仍是 0（那条只是被词卡住，不代表密度）
  const nonZero = counts.filter((n) => n > 0);
  const min = Math.min(...nonZero);
  const max = Math.max(...nonZero);
  return {
    verdict: 'opportunity',
    reason:
      `命中数中等（${fmtCounts(parsed)}，非零命中 ${min}–${max} 落在 6–${RED_OCEAN_HITS - 1}）：` +
      '单看数字判不了是红海还是机会，需读最近邻权利要求（独立权利要求的技术特征组合）再定' +
      suffix,
    status: statusOf('opportunity'),
  };
}

// ---------------------------------------------------------------- 给 UI 的紧凑摘要

export interface VerdictEvidence {
  query: string;
  hits: number | null;
  topAssignees: string;
}

export interface VerdictSummary {
  verdict: NoveltyVerdict;
  /** 能直接当徽标文案，≤ 24 字（如「稀疏交叉带：3 命中」/「红海：华为技术 21 件」） */
  headline: string;
  /** 逐条检索式的证据，前端表格直接用 */
  evidence: VerdictEvidence[];
  /** 可执行建议（不是「请人工判断」这种废话）；inconclusive 时必须给出改词建议 */
  suggestions: string[];
}

const MAX_HEADLINE_CHARS = 24;

const clip = (text: string, max = MAX_HEADLINE_CHARS): string => {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
};

const wordsOf = (query: string): string[] =>
  query
    .trim()
    .split(/\s+/u)
    .filter((word) => word !== '');

/** 头部申请人首个条目：「华为技术有限公司:21、腾讯:17」→ {name,count} */
function topApplicant(topAssignees: string): { name: string; count: number | null } | null {
  const first = topAssignees.split(/[、,，;；]/u)[0]?.trim() ?? '';
  if (first === '') return null;
  const matched = first.match(/^(.+?)\s*[:：]\s*([\d,]+)$/u);
  if (matched === null) return { name: first, count: null };
  const count = Number(matched[2]!.replace(/,/gu, ''));
  return { name: matched[1]!.trim(), count: Number.isFinite(count) ? count : null };
}

/**
 * 把 NoveltyRecord[] 压成 UI 摘要。
 *
 * 与 verdict() 的分工：verdict() 负责「结论 + 判读理由」（落库用），
 * 这里负责「徽标文案 + 证据表 + 下一步动作」（展示用）。两者共用同一套阈值，
 * 但绝不共用文案——理由要严谨可审计，徽标要一眼能读。
 */
export function summarizeVerdict(records: NoveltyRecord[]): VerdictSummary {
  const outcome = verdict(records);
  const evidence: VerdictEvidence[] = (Array.isArray(records) ? records : [])
    .filter((record): record is NoveltyRecord => Boolean(record))
    .map((record) => ({
      query: record.query,
      hits: record.hits,
      topAssignees: String(record.topAssignees ?? '').trim(),
    }));

  const parsed = evidence.filter((entry): entry is VerdictEvidence & { hits: number } => entry.hits !== null);
  const counts = parsed.map((entry) => entry.hits);
  const suggestions: string[] = [];
  let headline = '';

  if (evidence.length === 0) {
    headline = '未查新：无记录';
    suggestions.push('先跑一次智慧芽查新，或手工登记命中数后再判读');
  } else if (parsed.length === 0) {
    headline = '无法判断：解析失败';
    suggestions.push('确认智慧芽登录态与页面渲染时间后重跑');
    suggestions.push('换一条更短的检索式，验证能否取到命中数');
  } else if (counts.every((n) => n === 0)) {
    // 全零：这里最需要「可执行的改词建议」，否则用户会把它当成技术空白
    headline = '无法判断：全部零命中';
    const firstQuery = parsed[0]!.query;
    const words = wordsOf(firstQuery);
    if (words.length > 3) {
      suggestions.push(`去掉尾词「${words[words.length - 1]}」后重试`);
    }
    const rewritten = synonymRewrites(firstQuery);
    if (rewritten.length > 0) {
      suggestions.push(`把「${rewritten[0]!.from}」换成「${rewritten[0]!.to}」——实测同义改写会显著改变命中数`);
    } else {
      suggestions.push('把生僻术语换成领域通用词（如「推测执行」→「投机解码」）');
    }
    suggestions.push('减到 3 个词再跑：简单搜索是 AND 语义，词多即空');
    suggestions.push('核对全半角与中英文写法（智慧芽按词面匹配）');
  } else if (outcome.verdict === 'red-ocean') {
    const top = parsed.reduce((best, cur) => (cur.hits > best.hits ? cur : best));
    const applicant = topApplicant(top.topAssignees);
    headline = applicant === null ? `红海：${top.hits} 命中` : `红海：${applicant.name} ${top.hits} 件`;
    suggestions.push(
      applicant === null ? '避开头部申请人已覆盖的子问题' : `避开「${applicant.name}」已覆盖的子问题`,
    );
    suggestions.push('给检索式加限定词细分（按场景/模块）');
    suggestions.push('改从手段组合切入，别按单一功能检索');
  } else if (counts.some((n) => n >= 1 && n <= SPARSE_HITS_MAX)) {
    // 与 verdict() 的稀疏带口径一致：0 命中不算交叉带
    const first = parsed.find((entry) => entry.hits >= 1 && entry.hits <= SPARSE_HITS_MAX)!;
    headline = `稀疏交叉带：${first.hits} 命中`;
    suggestions.push('读这几篇最近邻的独立权利要求，确认区别技术特征');
    suggestions.push('把检索式减 1 词，看命中数是否跳升（判断是否被词卡住）');
  } else {
    const nonZero = counts.filter((n) => n > 0);
    const min = Math.min(...nonZero);
    const max = Math.max(...nonZero);
    headline = min === max ? `中间地带：${max} 命中` : `中间地带：${min}–${max} 命中`;
    suggestions.push('读最近邻权利要求定边界');
    suggestions.push('补一条更窄的检索式，验证是否只是术语差异');
  }

  return { verdict: outcome.verdict, headline: clip(headline), evidence, suggestions };
}
