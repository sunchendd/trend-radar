/**
 * 最小 DOCX 导出（零依赖，手写 ZIP + OOXML）。
 *
 * 为什么不用 `docx` 包：这个产品的整个卖点是「clone 下来 npm i 就能跑」，
 * 已经为了这点放弃了 better-sqlite3；为了导出 Word 再引入一个会拖一棵树的依赖不值当。
 * 我们只需要"能打开的、带标题/正文/表格文字的 .docx"，不需要页眉页脚样式表那一套。
 *
 * 实现要点：
 * - ZIP 用 STORED（不压缩）：交底书通常 10–30KB，压缩收益可以忽略，省掉 deflate 与方法的复杂度。
 * - CRC32 必须正确，否则 Word 会报"文件已损坏"。
 * - 用不到的 part（styles/theme）不写，Word 会自己兜底；[Content_Types].xml 里只声明实际存在的 part。
 */
import { deflateRawSync } from 'node:zlib';

// ------------------------------------------------------------------ ZIP

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  name: string;
  data: Buffer;
}

/** 构造 ZIP（DEFLATE，体积小且 Word 一定认）；时间戳固定，保证同样输入产出同样字节 */
export function buildZip(entries: ZipEntry[], dosTime = 0): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const raw = entry.data;
    const deflated = deflateRawSync(raw);
    const useDeflate = deflated.length < raw.length;
    const payload = useDeflate ? deflated : raw;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名标志
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(0x21, 12); // 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBuf, payload);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(useDeflate ? 8 : 0, 10);
    dir.writeUInt16LE(dosTime, 12);
    dir.writeUInt16LE(0x21, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(payload.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt16LE(0, 30); // extra
    dir.writeUInt16LE(0, 32); // comment
    dir.writeUInt16LE(0, 34); // disk
    dir.writeUInt16LE(0, 36); // internal attrs
    dir.writeUInt32LE(0, 38); // external attrs
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, eocd]);
}

// ------------------------------------------------------------------ OOXML

const escapeXml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // XML 1.0 不允许的控制字符：不清掉 Word 会整篇打不开
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

/** 一个段落；bold/size 用来区分标题层级 */
function paragraph(text: string, opts: { bold?: boolean; size?: number; mono?: boolean } = {}): string {
  if (text === '') return '<w:p/>';
  const rPr = [
    opts.bold ? '<w:b/>' : '',
    opts.mono ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="SimSun"/>' : '',
    opts.size ? `<w:sz w:val="${opts.size * 2}"/><w:szCs w:val="${opts.size * 2}"/>` : '',
  ].join('');
  return `<w:p><w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

/**
 * Markdown → Word 正文。
 * 只支持交底书实际会用到的那几种：`#`/`##`/`###` 标题、`- ` 列表、`>` 引用、表格行、普通段落。
 * 表格转成「制表符分隔的一段文字」——交底书的表本来就是给人看的清单，
 * 真要严格表格得写 tc/tbl 结构，收益不值当（而且列宽还得猜）。
 */
export function markdownToParagraphs(markdown: string): string[] {
  const out: string[] = [];
  for (const rawLine of markdown.split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    if (line === '') {
      out.push(paragraph(''));
      continue;
    }
    if (line.startsWith('### ')) {
      out.push(paragraph(line.slice(4), { bold: true, size: 12 }));
      continue;
    }
    if (line.startsWith('## ')) {
      out.push(paragraph(line.slice(3), { bold: true, size: 14 }));
      continue;
    }
    if (line.startsWith('# ')) {
      out.push(paragraph(line.slice(2), { bold: true, size: 18 }));
      continue;
    }
    if (line.startsWith('|')) {
      // 分隔行（|---|---|）直接丢；其余按单元格拼成制表符文本
      if (/^\|[\s:|-]+\|?$/.test(line)) continue;
      const cells = line
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((cell) => cell.trim());
      out.push(paragraph(cells.join('\t'), { size: 10 }));
      continue;
    }
    if (line.startsWith('> ')) {
      out.push(paragraph(line.slice(2), { size: 10 }));
      continue;
    }
    if (/^[-*] /.test(line)) {
      out.push(paragraph(`• ${line.slice(2)}`));
      continue;
    }
    out.push(paragraph(line));
  }
  return out;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

/** 生成 .docx 字节流；A4 + 2cm 页边距，正文 10.5pt（与国内交底书习惯接近） */
export function buildDocx(markdown: string): Buffer {
  const body = markdownToParagraphs(markdown).join('');
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body>
</w:document>`;

  return buildZip([
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(ROOT_RELS, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(document, 'utf8') },
  ]);
}
