/**
 * 极简 XML/HTML 文本处理工具。
 *
 * 为什么不装 XML 解析库：我们只面对两类固定形状的文档（arXiv Atom、RSS/Atom feed），
 * 需求只有「取某个标签的内容」和「取某个属性」。引入完整 DOM 解析器会带来
 * 依赖体积与实体处理差异，收益不成正比；代价是这里必须写得足够容错。
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
  copy: '©',
};

/** 解码 HTML/XML 实体（含数值实体）；一次扫描，避免 `&amp;lt;` 被解码两遍 */
export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1]?.toLowerCase() === 'x';
      const codePoint = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** 去掉标签、解 CDATA、压掉换行，得到可入库的纯文本摘要 */
export function stripTags(input: string): string {
  let text = input.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  // script/style 里的内容对读者毫无意义，先整块干掉再剥标签
  text = text.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ');
  text = text.replace(/<br\s*\/?>/gi, ' ');
  text = text.replace(/<\/(p|div|li|h[1-6])>/gi, ' ');
  // 必须先解码实体再剥标签：GitHub 的 <content type="html"> 给的是 `&lt;p&gt;…`，
  // 顺序反了就会把字面量 <p> 留在摘要里（这是最初踩过的坑）
  text = decodeEntities(text);
  text = text.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ');
  text = text.replace(/<[^>]+>/g, '');
  // 少数源双重转义（&amp;lt;p&amp;gt;），再解一次；这一步之后不再剥标签，避免吃掉正文里的比较符
  return decodeEntities(text).replace(/\s+/g, ' ').trim();
}

const escapeRegExp = (input: string): string => input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 取第一个 `<tag ...>inner</tag>` 的 inner（原样返回，调用方自己 stripTags） */
export function tagInner(xml: string, tag: string): string | undefined {
  const re = new RegExp(`<${escapeRegExp(tag)}(?:\\s[^>]*)?>([\\s\\S]*?)</${escapeRegExp(tag)}>`, 'i');
  return re.exec(xml)?.[1];
}

/** 取第一个 `<tag ... />` 的属性表 */
export function parseAttrs(rawAttrs: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match = re.exec(rawAttrs);
  while (match) {
    const name = match[1];
    if (name !== undefined) attrs[name.toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? '');
    match = re.exec(rawAttrs);
  }
  return attrs;
}

/**
 * 取条目链接。
 * - Atom：`<link rel="alternate" href="..."/>`（属性顺序不固定，必须逐个解析）；没有 alternate 就退到第一个 href
 * - RSS：`<link>https://...</link>`
 */
export function entryLink(block: string): string | undefined {
  const plain = tagInner(block, 'link');
  if (plain !== undefined && /^\s*(https?:|git:|urn:)/i.test(plain)) return plain.trim();

  const re = /<link\b([^>]*?)\/?>/gi;
  const candidates: Record<string, string>[] = [];
  let match = re.exec(block);
  while (match) {
    const attrs = parseAttrs(match[1] ?? '');
    if (attrs['href']) candidates.push(attrs);
    match = re.exec(block);
  }

  const alternate = candidates.find((attrs) => (attrs['rel'] ?? '').toLowerCase() === 'alternate');
  return (alternate ?? candidates[0])?.['href'];
}
