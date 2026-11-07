/**
 * Bark 每日推送（iOS 通知 App 的 GET URL 协议）。为什么这么设计：
 *
 * 1. **可选能力的静默契约**：enabled=false 或 url 为空时 pushDailyDigest 直接返回
 *    false，不发请求不报错——没配置 Bark 的用户不该在日志里看到任何推送噪音。
 * 2. **传输与内容分离**：pushBark 只负责「把一段文本 GET 到 Bark 服务器」（10s 超时，
 *    非 2xx 抛错）；buildDailyDigest 只负责「把采集结果拼成摘要」。测试各自离线可测，
 *    失败也绝不影响采集（调用方 catch 后只记日志）。
 * 3. **URL 形态**：`{base}/{encodeURIComponent(标题)}/{encodeURIComponent(正文)}`——
 *    Bark 对路径参数里的中文/换行靠编码解决，base 末尾斜杠必须先剥掉防双斜杠。
 */
import type { AppSettings, Idea, Item, Paged } from '../types.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const BARK_TITLE = '情报雷达日报';
/** 单次推送超时：通知类请求不值得等太久，卡住比失败更伤体验 */
export const BARK_TIMEOUT_MS = 10_000;

/**
 * 拼 Bark 推送 URL；base 允许带末尾斜杠。
 * base 允许带 Bark 参数（?group=…&ttl=…）：路径段插在 ? 之前，参数原样保留——
 * 用户从 Bark 文档复制来的 URL 往往自带 group/sound 等 query，不能把它们拼进路径。
 */
export function barkUrl(base: string, title: string, body: string): string {
  const trimmed = base.trim().replace(/\/+$/u, '');
  const qIndex = trimmed.indexOf('?');
  if (qIndex === -1) {
    return `${trimmed}/${encodeURIComponent(title)}/${encodeURIComponent(body)}`;
  }
  const root = trimmed.slice(0, qIndex).replace(/\/+$/u, '');
  return `${root}/${encodeURIComponent(title)}/${encodeURIComponent(body)}${trimmed.slice(qIndex)}`;
}

/** 生效配置快照；调用方拿 deps.getSettings() 喂进来 */
export function resolveBarkConfig(settings: AppSettings): { url: string; enabled: boolean } {
  return { url: settings.bark.url.trim(), enabled: settings.bark.enabled };
}

/** 推送一条消息；网络失败/非 2xx 抛 Error，由调用方决定记日志还是映射成 HTTP 错误 */
export async function pushBark(
  fetchLike: FetchLike,
  base: string,
  title: string,
  body: string,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  const response = await fetchLike(barkUrl(base, title, body), {
    signal: AbortSignal.timeout(options.timeoutMs ?? BARK_TIMEOUT_MS),
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Bark 返回 HTTP ${response.status}`);
}

/** 日报正文：近 24h 高分 Top5（分数+标题短截）+ 新增选题数 */
export function buildDailyDigest(topItems: { score: number; title: string }[], newIdeaCount: number): string {
  const lines: string[] = [];
  if (topItems.length === 0) {
    lines.push('近 24 小时没有新高分情报');
  } else {
    lines.push('近24h 高分情报 Top5：');
    for (const [index, item] of topItems.entries()) {
      lines.push(`${index + 1}. [${item.score}] ${[...item.title.trim()].slice(0, 40).join('')}`);
    }
  }
  lines.push(`新增选题：${newIdeaCount} 条`);
  return lines.join('\n');
}

/** 推送需要的最小能力集（HttpDeps 的结构化子集，测试按需实现） */
export interface DigestSource {
  listItems(query: { sort?: 'score' | 'time'; since?: string; limit?: number }): Paged<Item>;
  listIdeas(status?: Idea['status']): Idea[];
  getSettings(): AppSettings;
}

/**
 * 采集完成后的每日推送。全程静默：未启用/未配置返回 false 什么都不做；
 * 已配置时取近 24h 高分 Top5 + 新增选题数推送，失败把错误抛给调用方记日志。
 */
export async function pushDailyDigest(source: DigestSource, fetchLike: FetchLike = fetch): Promise<boolean> {
  const { url, enabled } = resolveBarkConfig(source.getSettings());
  if (!enabled || url === '') return false;

  const since = new Date(Date.now() - 24 * 3_600_000).toISOString(); // 近 24 小时
  const topItems = source
    .listItems({ sort: 'score', since, limit: 5 })
    .items.map((item) => ({ score: item.score, title: item.title }));
  const newIdeaCount = source.listIdeas().filter((idea) => idea.createdAt >= since).length;

  await pushBark(fetchLike, url, BARK_TITLE, buildDailyDigest(topItems, newIdeaCount));
  return true;
}
