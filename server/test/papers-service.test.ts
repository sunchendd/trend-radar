import { existsSync, readFileSync, rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/store/db.js';
import { insertItems } from '../src/store/queries.js';
import { makeRawItem, toIsoString } from '../src/sources/raw.js';
import type { Item } from '../src/types.js';
import { createPaperService, PaperError } from '../src/papers/service.js';
import { extractPatentPdfLink, resolvePdfUrl } from '../src/papers/resolve.js';

/** papers/resolve + papers/service 的行为测试：假 fetch，全程不出网。 */

function makeItem(over: Partial<Item> = {}): Item {
  const raw = makeRawItem({
    sourceId: 'arxiv-spec',
    kind: 'paper',
    title: 'Fast Speculative Decoding',
    url: 'https://arxiv.org/abs/2401.12345v2',
    summary: '摘要',
    authors: [],
    publishedAt: toIsoString('2026-10-20T00:00:00Z', new Date()),
    externalId: '2401.12345v2',
  });
  return { ...raw, fetchedAt: raw.publishedAt, score: 90, scoreReasons: [], keywords: [], ...over };
}

const PDF_BYTES = Buffer.from('%PDF-1.4\n fake pdf body \n%%EOF\n', 'latin1');

describe('resolvePdfUrl：三条解析路径', () => {
  it('arXiv externalId（带版本号）→ 官方 PDF 端点（去掉版本号也能命中）', () => {
    expect(resolvePdfUrl({ url: 'https://arxiv.org/abs/2401.12345v2', externalId: '2401.12345v2' })).toEqual({
      itemUrl: 'https://arxiv.org/abs/2401.12345v2',
      pdfUrl: 'https://arxiv.org/pdf/2401.12345',
      via: 'arxiv',
    });
    expect(resolvePdfUrl({ url: 'http://arxiv.org/abs/2505.99999', externalId: undefined })?.pdfUrl).toBe(
      'https://arxiv.org/pdf/2505.99999',
    );
  });

  it('直接 PDF 链接原样使用；查询串不干扰', () => {
    expect(resolvePdfUrl({ url: 'https://openreview.net/pdf?id=abc', externalId: undefined })?.via).toBe('direct');
    expect(resolvePdfUrl({ url: 'https://example.com/paper.pdf?dl=1' })).toMatchObject({ via: 'direct', pdfUrl: 'https://example.com/paper.pdf?dl=1' });
  });

  it('Google Patents 返回 marker，交给下载器二次解析；普通新闻返回 null', () => {
    expect(resolvePdfUrl({ url: 'https://patents.google.com/patent/CN119123456A/zh' })).toMatchObject({ via: 'google-patents' });
    expect(resolvePdfUrl({ url: 'https://www.qbitai.com/2026/11/some-news.html' })).toBeNull();
    expect(resolvePdfUrl({ url: 'not a url at all' })).toBeNull();
  });

  it('extractPatentPdfLink 只认 patentimages host', () => {
    expect(
      extractPatentPdfLink('<a href="https://patentimages.storage.googleapis.com/pdfs/ab/cd/ef.pdf">Download PDF</a>'),
    ).toBe('https://patentimages.storage.googleapis.com/pdfs/ab/cd/ef.pdf');
    expect(extractPatentPdfLink('<a href="https://evil.example.com/x.pdf">Download PDF</a>')).toBeNull();
  });
});

describe('createPaperService：下载与状态', () => {
  let dir: string;
  let db: ReturnType<typeof openDb>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tr-papers-'));
    db = openDb(':memory:');
    insertItems(db, [makeItem()]);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const make = (fetchImpl?: typeof fetch) =>
    createPaperService(db, { papersDir: dir, ...(fetchImpl ? { fetchImpl } : {}) });

  it('下载成功：状态 ready、文件落盘、file() 可读、字节校验一致', async () => {
    const fetchCalls: string[] = [];
    const service = make(async (url) => {
      fetchCalls.push(String(url));
      return new Response(PDF_BYTES, { status: 200 });
    });

    const item = makeItem();
    const info = await service.download(item.id, item);
    expect(info).toMatchObject({ status: 'ready', bytes: PDF_BYTES.byteLength, originUrl: 'https://arxiv.org/pdf/2401.12345' });
    expect(fetchCalls).toEqual(['https://arxiv.org/pdf/2401.12345']);

    const file = service.file(item.id);
    expect(file).toBeDefined();
    expect(readFileSync(file!.path).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('已 ready 时幂等：不再发请求直接返回', async () => {
    let calls = 0;
    const service = make(async () => {
      calls += 1;
      return new Response(PDF_BYTES, { status: 200 });
    });
    const item = makeItem();
    await service.download(item.id, item);
    expect(calls).toBe(1);
    await service.download(item.id, item);
    expect(calls).toBe(1);
  });

  it('HTML 冒充 PDF（魔数不符）→ failed 且错误可读', async () => {
    const service = make(async () =>
      new Response('<html><body>Too Many Requests</body></html>', {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      }),
    );
    const item = makeItem();
    const info = await service.download(item.id, item);
    expect(info.status).toBe('failed');
    expect(info.error).toContain('不是 PDF');
    expect(existsSync(join(dir, `${item.id}.pdf`))).toBe(false);
  });

  it('HTTP 429 → failed；status() 能查到同一原因', async () => {
    const service = make(async () => new Response('rate limited', { status: 429 }));
    const item = makeItem();
    const info = await service.download(item.id, item);
    expect(info.status).toBe('failed');
    expect(service.status(item.id).error).toBe(info.error);
  });

  it('并发触发同一 item 只发一次请求（in-flight 复用）', async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = make(async () => {
      calls += 1;
      await gate;
      return new Response(PDF_BYTES, { status: 200 });
    });
    const item = makeItem();
    const first = service.download(item.id, item);
    const second = service.download(item.id, item);
    // 两个调用都已经在飞但 fetch 只该发一次；先放行下载再收结果，避免死锁
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toBe(1);
    release?.();
    const [a, b] = await Promise.all([first, second]);
    expect(a.status).toBe('ready');
    expect(b.status).toBe('ready');
  });

  it('进程重启后的僵尸 pending：status() 自愈为 failed（可重试）', async () => {
    const { upsertPaperInfo } = await import('../src/store/papers.js');
    upsertPaperInfo(db, { itemId: makeItem().id, status: 'pending' });
    const service = make();
    const info = service.status(makeItem().id);
    expect(info.status).toBe('failed');
    expect(info.error).toContain('中断');
  });

  it('非 arXiv 条目（新闻）→ paper_no_pdf 状态 failed，不写文件', async () => {
    const service = make(async () => new Response(PDF_BYTES, { status: 200 }));
    const news = makeItem({ id: 'eeeeeeeeeeeeeeee', kind: 'news', url: 'https://www.qbitai.com/x.html', externalId: undefined });
    insertItems(db, [news]);
    const info = await service.download(news.id, news);
    expect(info.status).toBe('failed');
    expect(info.error).toContain('没有可下载的 PDF');
  });

  it('Google Patents：先抓页面解析出 patentimages 链接，再下载 PDF', async () => {
    const urls: string[] = [];
    const service = make(async (url) => {
      urls.push(String(url));
      if (String(url).includes('patents.google.com')) {
        return new Response(
          '<html><a href="https://patentimages.storage.googleapis.com/pdfs/x/y/z.pdf">Download PDF</a></html>',
          { status: 200 },
        );
      }
      return new Response(PDF_BYTES, { status: 200 });
    });
    const patent = makeItem({ id: 'ffffffffffffffff', url: 'https://patents.google.com/patent/US1234567B2/en', externalId: undefined });
    insertItems(db, [patent]);
    const info = await service.download(patent.id, patent);
    expect(info.status).toBe('ready');
    expect(urls).toEqual([
      'https://patents.google.com/patent/US1234567B2/en',
      'https://patentimages.storage.googleapis.com/pdfs/x/y/z.pdf',
    ]);
  });

  it('非法条目 id 抛 PaperError(invalid_item_id)，绝不拼出任意路径', async () => {
    const service = make();
    await expect(service.download('../../etc/passwd', makeItem())).rejects.toMatchObject({
      name: 'PaperError',
      code: 'invalid_item_id',
    } satisfies Partial<PaperError>);
  });

  it('pruneOrphans：孤儿条目的 DB 行与磁盘文件一起消失', async () => {
    const service = make(async () => new Response(PDF_BYTES, { status: 200 }));
    const item = makeItem();
    await service.download(item.id, item);
    expect(existsSync(join(dir, `${item.id}.pdf`))).toBe(true);

    db.prepare('DELETE FROM items WHERE id = ?').run(item.id);
    const removed = await service.pruneOrphans();
    expect(removed).toBe(1);
    expect(existsSync(join(dir, `${item.id}.pdf`))).toBe(false);
  });
});
