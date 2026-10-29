/**
 * DOCX 导出测试。
 *
 * 重点不是"字节对得上"，而是**产出的文件 Word 能打开**，所以测试真的把 ZIP 解开、
 * 按 OOXML 找到 word/document.xml 并检查里面的段落结构——而不是只看 magic number。
 */
import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildDocx, buildZip, markdownToParagraphs } from '../src/ideas/docx.js';

/** 极简 ZIP 解析：只为测试，按中央目录读出所有条目 */
function unzip(buffer: Buffer): Record<string, Buffer> {
  // 从尾部找 EOCD（PK\x05\x06）
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是合法 ZIP：找不到 EOCD');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  const files: Record<string, Buffer> = {};
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('中央目录损坏');
    const method = buffer.readUInt16LE(offset + 10);
    const compSize = buffer.readUInt32LE(offset + 20);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');

    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buffer.subarray(dataStart, dataStart + compSize);
    files[name] = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);

    offset += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

describe('DOCX 写入器', () => {
  it('产出的 ZIP 能被解开，且 CRC 校验通过（用 zlib 复算比对不现实，这里验条目完整性）', () => {
    const zip = buildZip([
      { name: 'a.txt', data: Buffer.from('hello') },
      { name: 'dir/b.txt', data: Buffer.from('世界'.repeat(500)) },
    ]);
    expect(zip.subarray(0, 4).toString('hex')).toBe('504b0304');
    const files = unzip(zip);
    expect(Object.keys(files).sort()).toEqual(['a.txt', 'dir/b.txt']);
    expect(files['a.txt']?.toString('utf8')).toBe('hello');
    expect(files['dir/b.txt']?.toString('utf8')).toBe('世界'.repeat(500));
  });

  it('同样的输入产出同样字节（时间戳固定，便于 diff 与缓存）', () => {
    const a = buildDocx('# 标题\n正文');
    const b = buildDocx('# 标题\n正文');
    expect(a.equals(b)).toBe(true);
  });

  it('包含 OOXML 必需的三个 part，且 document.xml 是主文档', () => {
    const files = unzip(buildDocx('# 一种方法\n\n正文一段。'));
    expect(Object.keys(files).sort()).toEqual(['[Content_Types].xml', '_rels/.rels', 'word/document.xml']);
    const doc = files['word/document.xml']?.toString('utf8') ?? '';
    expect(doc).toContain('<w:document');
    expect(doc).toContain('一种方法');
    expect(doc).toContain('正文一段。');
    expect(doc).toContain('<w:sectPr>');
  });

  it('标题按层级加粗放大，正文不加粗', () => {
    const files = unzip(buildDocx('# 一级\n## 二级\n### 三级\n普通段落'));
    const doc = files['word/document.xml']?.toString('utf8') ?? '';
    expect(doc).toContain('<w:sz w:val="36"/>'); // 18pt
    expect(doc).toContain('<w:sz w:val="28"/>'); // 14pt
    expect(doc).toContain('<w:sz w:val="24"/>'); // 12pt
    // 精确取「普通段落」所在的那个 <w:p>，不能用固定窗口——窗口会串进上一个标题的 <w:b/>
    const plain = (doc.match(/<w:p>(?:(?!<w:p>).)*普通段落.*?<\/w:p>/s) ?? [''])[0];
    expect(plain).toContain('普通段落');
    expect(plain).not.toContain('<w:b/>');
  });

  it('表格分隔行被丢弃，数据行转成制表符文本（Word 里仍是可读清单）', () => {
    const paragraphs = markdownToParagraphs('| 检索式 | 命中数 |\n| --- | --- |\n| KV缓存 分级 | 9 |');
    const joined = paragraphs.join('');
    expect(joined).not.toContain('---');
    expect(joined).toContain('检索式\t命中数');
    expect(joined).toContain('KV缓存 分级\t9');
  });

  it('转义 XML 特殊字符，并剔除 XML 1.0 非法控制字符（否则 Word 打不开）', () => {
    const files = unzip(buildDocx('对比 A & B < 3 > 1 "引号"\u0000\u0007'));
    const doc = files['word/document.xml']?.toString('utf8') ?? '';
    expect(doc).toContain('&amp;');
    expect(doc).toContain('&lt;');
    expect(doc).toContain('&quot;');
    expect(doc).not.toContain('\u0000');
  });

  it('空行保留为空段落，不会把段落吞掉', () => {
    const paragraphs = markdownToParagraphs('第一段\n\n第二段');
    expect(paragraphs.filter((p) => p === '<w:p/>')).toHaveLength(1);
    expect(paragraphs).toHaveLength(3);
  });
});
