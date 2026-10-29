/**
 * 选题聚类（纯函数，无 IO）
 *
 * 为什么需要：工作台里十几条选题，标题各不相同，但很可能是**同一个技术方向**的几种写法。
 * 没有聚类，用户会：① 把同一方向当不同方向分别写交底书（重复劳动）；
 * ② 或者以为撞车了，其实是自己一周前那条。
 *
 * 为什么不用 embedding：这个产品刻意不引向量库（要 clone 即跑）。中文标题的判别信号
 * 主要来自**技术词**而不是语序，所以用「中文二元组 + 英文词干」的集合相似度足够，
 * 而且结果可解释——能直接告诉用户"因为都含 KV缓存/分级/传输"。
 */

export interface ClusterInputIdea {
  id: string;
  title: string;
  keywords?: string[];
  focus?: string;
}

export interface IdeaCluster<T extends ClusterInputIdea = ClusterInputIdea> {
  /** 稳定的簇 id：由成员 id 排序后哈希，重算不会变 */
  id: string;
  /** 展示名：簇内最高频的技术词拼成，例如「KV缓存 · 分级 · 传输」 */
  label: string;
  /** 簇内共享的技术词（用于解释「为什么归到一起」） */
  sharedTerms: string[];
  ideas: T[];
}

/** 阈值取 0.22：中文二元组在"同一方向不同写法"上通常 0.25–0.5，误合并多发生在 0.2 以下 */
export const CLUSTER_THRESHOLD = 0.22;

const STOPWORDS = new Set([
  '一种', '方法', '装置', '系统', '技术', '基于', '用于', '面向', '实现', '以及', '及其',
  '的', '和', '与', '及', '在', '中', '对', '为', '上', '下', '通过', '采用',
]);

const isCjk = (ch: string): boolean => /[\u4e00-\u9fff]/.test(ch);

/**
 * 切成「中文二元组 + 英文/数字词」。
 *
 * 中文不分词，用二元组：不需要词典，专有名词（"投机解码"）也会落成同一组二元组。
 * 停用词在**切二元组之前**整段剔掉——否则「一种方法」会被切成「种方」这种毫无意义的词，
 * 反而让所有标题都相像。
 */
export function terms(text: string): string[] {
  const out: string[] = [];
  const lower = text.toLowerCase();

  for (const word of lower.match(/[a-z][a-z0-9+#.]{1,}/g) ?? []) {
    const cleaned = word.replace(/[.]+$/, '');
    if (cleaned.length >= 2 && !STOPWORDS.has(cleaned)) out.push(cleaned);
  }

  let cjk = lower.replace(/[^\u4e00-\u9fff]+/g, ' ');
  // 先剔除多字停用词，再剔除单字停用词
  for (const word of [...STOPWORDS].sort((a, b) => b.length - a.length)) {
    if (word.length === 0) continue;
    cjk = cjk.split(word).join(' ');
  }
  for (const run of cjk.split(/\s+/).filter(Boolean)) {
    for (let i = 0; i + 1 < run.length; i += 1) out.push(run.slice(i, i + 2));
  }
  return out;
}

/**
 * 选题的可比较文本。
 * - sim：标题重复两遍（权重高）+ 关键词 + focus，切二元组，用于算相似度。
 * - words：关键词 + focus + 标题里的英文词。**展示用**——从二元组里挑"共享词"会挑出
 *   「型长」这种跨词边界的碎片，拿它当簇名没法看。
 */
function ideaTerms(idea: ClusterInputIdea): { sim: Set<string>; words: Set<string> } {
  const text = [idea.title, idea.title, ...(idea.keywords ?? []), idea.focus ?? ''].join(' ');
  const words = new Set<string>();
  for (const keyword of [...(idea.keywords ?? []), idea.focus ?? '']) {
    for (const word of keyword.split(/[\s,，、/]+/)) if (word.trim().length >= 2) words.add(word.trim());
  }
  for (const word of idea.title.toLowerCase().match(/[a-z][a-z0-9+#.]{1,}/g) ?? []) {
    if (word.length >= 2) words.add(word.replace(/[.]+$/, ''));
  }
  return { sim: new Set(terms(text)), words };
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const term of a) if (b.has(term)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/** 稳定 id：FNV-1a 取 8 位十六进制，成员顺序无关 */
function clusterId(ids: string[]): string {
  const joined = [...ids].sort().join('|');
  let hash = 0x811c9dc5;
  for (let i = 0; i < joined.length; i += 1) {
    hash ^= joined.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `cl-${hash.toString(16).padStart(8, '0')}`;
}

/** 簇内高频且至少出现在两个成员里的词：用来解释「凭什么归一类」 */
function sharedTerms(members: Set<string>[], limit = 3): string[] {
  if (members.length < 2) return [];
  const counts = new Map<string, number>();
  for (const member of members) for (const term of member) counts.set(term, (counts.get(term) ?? 0) + 1);
  return [...counts.entries()]
    .filter(([term, count]) => count >= 2 && term.length >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([term]) => term);
}

/**
 * 聚类（并查集单链）：A~B、B~C 会把 A/B/C 归一类。
 * 单链的后果是可能连成一条长链，所以阈值没有取得太低——宁可漏合并，不要错合并：
 * 错合并会让两条真正不同的选题被当一条，代价比漏合并高。
 */
export function clusterIdeas<T extends ClusterInputIdea>(
  ideas: T[],
  threshold: number = CLUSTER_THRESHOLD,
): IdeaCluster<T>[] {
  if (ideas.length === 0) return [];

  const termSets = ideas.map(ideaTerms);
  const simSets = termSets.map((entry) => entry.sim);
  const parent = ideas.map((_, index) => index);
  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root] as number;
    while (parent[x] !== root) {
      const next = parent[x] as number;
      parent[x] = root;
      x = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  for (let i = 0; i < ideas.length; i += 1) {
    for (let j = i + 1; j < ideas.length; j += 1) {
      if (jaccard(simSets[i] as Set<string>, simSets[j] as Set<string>) >= threshold) union(i, j);
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < ideas.length; i += 1) {
    const root = find(i);
    const list = groups.get(root);
    if (list) list.push(i);
    else groups.set(root, [i]);
  }

  const clusters: IdeaCluster<T>[] = [];
  for (const indexes of groups.values()) {
    const members = indexes.map((index) => ideas[index] as T);
    // 先用可读的技术词，一个都没有（例如全靠标题相似）再退回共享二元组
    const readable = sharedTerms(indexes.map((index) => (termSets[index] as { words: Set<string> }).words));
    const shared = readable.length > 0 ? readable : sharedTerms(indexes.map((index) => simSets[index] as Set<string>));
    clusters.push({
      id: clusterId(members.map((m) => m.id)),
      label: shared.length > 0 ? shared.slice(0, 2).join(' · ') : (members[0]?.title ?? '').slice(0, 12),
      sharedTerms: shared,
      ideas: members,
    });
  }

  // 大簇在前；同规模按 id 稳定排序，避免每次请求顺序抖动
  return clusters.sort((a, b) => b.ideas.length - a.ideas.length || a.id.localeCompare(b.id));
}
