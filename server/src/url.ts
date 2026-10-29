import { createHash } from 'node:crypto';

/**
 * URL 归一化与去重键。
 *
 * 为什么单独一层：抓取端（sources/*）和存储端（store/*）都要算同一个键，
 * 两边各写一份必然漂移；去重键一旦漂移就会出现「同一条情报每天重复入库」。
 */

/** 追踪参数一律丢弃：同一篇文章带不带 utm 在业务上是同一条 */
const TRACKING_PARAMS = new Set([
  'fbclid',
  'gclid',
  'mc_cid',
  'mc_eid',
  'ref_src',
  'ref_url',
  'spm',
  'from',
  'source',
]);

/**
 * 归一化 URL，只保留「决定这是哪一条情报」的部分：
 * - http → https（同一资源两个协议视为同一条）
 * - host 小写、去掉默认端口、去掉末尾斜杠
 * - 丢掉 utm_* 等追踪参数，剩余参数排序（顺序不同不算不同条）
 * - 丢掉 fragment（同一页面不同锚点视为同一条）
 */
export function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    // 不是合法 URL（少数 RSS 给的是相对地址或裸串）→ 退化为小写去空格，
    // 至少保证同源同写法能去重，而不是抛异常让整轮采集挂掉
    return trimmed.toLowerCase();
  }

  if (parsed.protocol === 'http:') parsed.protocol = 'https:';

  parsed.hostname = parsed.hostname.toLowerCase();
  if ((parsed.protocol === 'https:' && parsed.port === '443') || (parsed.protocol === 'http:' && parsed.port === '80')) {
    parsed.port = '';
  }

  parsed.hash = '';

  const params = [...parsed.searchParams.entries()]
    .filter(([key]) => !key.toLowerCase().startsWith('utm_') && !TRACKING_PARAMS.has(key.toLowerCase()))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  parsed.search = '';
  for (const [key, value] of params) parsed.searchParams.append(key, value);

  // pathname 的末尾斜杠不影响内容，但会影响字符串比较
  let pathname = parsed.pathname;
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.replace(/\/+$/, '');
  parsed.pathname = pathname || '/';

  return parsed.toString();
}

/** 去重键：sha1(sourceId + '\n' + normalizeUrl(url)) 前 16 位（契约要求，见 types.Item.id） */
export function itemId(sourceId: string, url: string): string {
  return createHash('sha1').update(`${sourceId}\n${normalizeUrl(url)}`).digest('hex').slice(0, 16);
}
