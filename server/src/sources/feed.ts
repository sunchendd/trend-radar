import type { ItemKind, Source } from '../types.js';
import { extractExternalId, makeRawItem, toIsoString, type RawItem } from './raw.js';
import { entryLink, stripTags, tagInner } from './xml.js';

/**
 * 通用 RSS 2.0 / Atom 解析（GitHub Releases 的 releases.atom 也走这里）。
 *
 * 现实约束：
 * - 两种格式字段名不同（item/entry、description/summary|content、pubDate/published），
 *   但结构足够像，一个解析器 + 分支比两套解析器更好维护。
 * - GitHub 的 `<content type="html">` 是整段转义 HTML，必须 stripTags + 解码实体，
 *   否则列表里会出现 `&lt;p&gt;` 这种脏字符。
 * - 很多 blog 的 Atom 没有 `<published>`，只有 `<updated>`；时间缺失时退到抓取时刻。
 */

const ATOM_ENTRY = /<entry\b[\s\S]*?<\/entry>/gi;
const RSS_ITEM = /<item\b[\s\S]*?<\/item>/gi;
const ATOM_AUTHOR = /<author\b[\s\S]*?<\/author>/gi;

function resolveKind(source: Source): ItemKind {
  if (source.kind === 'arxiv') return 'paper';
  // 「正式发版」是工程验证信号：靠标签和 URL 判，而不是靠源 id 命名约定
  if (source.tags.includes('release') || /\/releases(\/|\.atom)/i.test(source.url)) return 'release';
  return 'news';
}

/** RSS 的 <guid> 常用作稳定主键，某些源没有 <link>，此时 guid 就是唯一可点的地址 */
function rssLink(block: string): string | undefined {
  const link = entryLink(block);
  if (link) return link;
  const guid = tagInner(block, 'guid');
  if (guid && /^\s*https?:/i.test(guid)) return guid.trim();
  return undefined;
}

function atomAuthors(block: string): string[] {
  const authors: string[] = [];
  for (const authorBlock of block.match(ATOM_AUTHOR) ?? []) {
    const name = stripTags(tagInner(authorBlock, 'name') ?? '');
    if (name) authors.push(name);
  }
  return authors;
}

function rssAuthors(block: string): string[] {
  const creators = stripTags(tagInner(block, 'dc:creator') ?? '');
  if (creators) return [creators];
  const author = stripTags(tagInner(block, 'author') ?? '');
  // RSS 的 <author> 有时是 `email (Name)`，取括号里的名字更可读
  if (!author) return [];
  const inParens = /\(([^)]+)\)/.exec(author)?.[1];
  return [inParens?.trim() || author.trim()];
}

export function parseFeed(xml: string, source: Source, fetchedAt: Date = new Date()): RawItem[] {
  const kind = resolveKind(source);
  const items: RawItem[] = [];

  const atomEntries = xml.match(ATOM_ENTRY) ?? [];
  if (atomEntries.length > 0) {
    for (const entry of atomEntries) {
      const url = entryLink(entry)?.trim();
      const title = stripTags(tagInner(entry, 'title') ?? '');
      if (!url || !title) continue;

      const summary = stripTags(tagInner(entry, 'summary') ?? tagInner(entry, 'content') ?? '');
      const published = tagInner(entry, 'published') ?? tagInner(entry, 'updated');

      items.push(
        makeRawItem({
          sourceId: source.id,
          kind,
          title,
          url,
          summary,
          authors: atomAuthors(entry),
          publishedAt: toIsoString(published, fetchedAt),
          externalId: extractExternalId(url, `${title} ${summary}`),
        }),
      );
    }
    return items;
  }

  for (const item of xml.match(RSS_ITEM) ?? []) {
    const url = rssLink(item)?.trim();
    const title = stripTags(tagInner(item, 'title') ?? '');
    if (!url || !title) continue;

    const summary = stripTags(
      tagInner(item, 'description') ?? tagInner(item, 'content:encoded') ?? tagInner(item, 'summary') ?? '',
    );
    const published = tagInner(item, 'pubDate') ?? tagInner(item, 'published') ?? tagInner(item, 'updated');

    items.push(
      makeRawItem({
        sourceId: source.id,
        kind,
        title,
        url,
        summary,
        authors: rssAuthors(item),
        publishedAt: toIsoString(published, fetchedAt),
        externalId: extractExternalId(url, `${title} ${summary}`),
      }),
    );
  }

  return items;
}
