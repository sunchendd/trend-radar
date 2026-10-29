import type { Source } from '../types.js';
import { extractExternalId, makeRawItem, toIsoString, type RawItem } from './raw.js';
import { entryLink, stripTags, tagInner } from './xml.js';

/**
 * arXiv API（Atom XML）解析。
 *
 * 几个必须处理的真实情况：
 * - `<entry><id>` 里给的是 `http://arxiv.org/abs/...`（http 且带版本号），
 *   而 `<link rel="alternate">` 才是 https；两者要去重成同一条，靠 externalId 去版本号。
 * - `<title>` / `<summary>` 里带换行和缩进，直接入库会让前端列表出现大段空白。
 * - 一条 entry 都没有是正常返回（关键词太窄），不是错误。
 */

const ENTRY = /<entry\b[\s\S]*?<\/entry>/gi;
const AUTHOR = /<author\b[\s\S]*?<\/author>/gi;

export function parseArxivAtom(xml: string, source: Source, fetchedAt: Date = new Date()): RawItem[] {
  const items: RawItem[] = [];
  const entries = xml.match(ENTRY) ?? [];

  for (const entry of entries) {
    const rawId = tagInner(entry, 'id')?.trim() ?? '';
    const link = entryLink(entry);
    // 优先 https 的 alternate 链接；缺失时把 id 里的 http 换成 https
    const url = (link ?? rawId.replace(/^http:/i, 'https:')).trim();
    const title = stripTags(tagInner(entry, 'title') ?? '');
    if (!url || !title) continue;

    const authors: string[] = [];
    for (const block of entry.match(AUTHOR) ?? []) {
      const name = stripTags(tagInner(block, 'name') ?? '');
      if (name) authors.push(name);
    }

    const published = tagInner(entry, 'published') ?? tagInner(entry, 'updated');
    const summary = stripTags(tagInner(entry, 'summary') ?? '');
    // arxiv:doi 只有正式发表过的论文才有，命中它就能和期刊版本合并
    const doi = stripTags(tagInner(entry, 'arxiv:doi') ?? '');

    const externalId = extractExternalId(rawId) ?? extractExternalId(url) ?? (doi || undefined);

    items.push(
      makeRawItem({
        sourceId: source.id,
        kind: 'paper',
        title,
        url,
        summary,
        authors,
        publishedAt: toIsoString(published, fetchedAt),
        externalId,
      }),
    );
  }

  return items;
}
