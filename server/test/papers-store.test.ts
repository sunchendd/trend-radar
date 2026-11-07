import { describe, expect, it } from 'vitest';
import { openDb } from '../src/store/db.js';
import {
  addAnnotation,
  getPaperInfo,
  listAnnotations,
  pruneOrphanPapers,
  removeAnnotation,
  updateAnnotation,
  upsertPaperInfo,
} from '../src/store/papers.js';
import { insertItems } from '../src/store/queries.js';
import { makeRawItem, toIsoString } from '../src/sources/raw.js';
import type { Item } from '../src/types.js';

/** store/papers 的行为测试：:memory: 库，全程不出网。 */

function makeItem(id: string, over: Partial<Item> = {}): Item {
  const raw = makeRawItem({
    sourceId: 'arxiv-spec',
    kind: 'paper',
    title: 'Fast Speculative Decoding',
    url: `https://arxiv.org/abs/2401.12345`,
    summary: '摘要',
    authors: ['张三'],
    publishedAt: toIsoString('2026-10-20T00:00:00Z', new Date()),
  });
  return { ...raw, fetchedAt: raw.publishedAt, score: 90, scoreReasons: [], keywords: [], id, ...over };
}

describe('papers 表：下载状态机', () => {
  it('未下载 → none；状态流转 none→pending→ready→failed 均可查询', () => {
    const db = openDb(':memory:');
    try {
      expect(getPaperInfo(db, 'aaaaaaaaaaaaaaaa').status).toBe('none');

      upsertPaperInfo(db, { itemId: 'aaaaaaaaaaaaaaaa', status: 'pending', originUrl: 'https://arxiv.org/pdf/2401.12345' });
      expect(getPaperInfo(db, 'aaaaaaaaaaaaaaaa')).toMatchObject({ status: 'pending', bytes: null, error: '' });

      upsertPaperInfo(db, {
        itemId: 'aaaaaaaaaaaaaaaa',
        status: 'ready',
        bytes: 12345,
        downloadedAt: '2026-11-06T03:00:00.000Z',
      });
      expect(getPaperInfo(db, 'aaaaaaaaaaaaaaaa')).toMatchObject({
        status: 'ready',
        bytes: 12345,
        downloadedAt: '2026-11-06T03:00:00.000Z',
      });
      // originUrl 是最后一次设置的值：失败重试用新地址覆盖旧地址
      upsertPaperInfo(db, { itemId: 'aaaaaaaaaaaaaaaa', status: 'failed', error: 'HTTP 429' });
      expect(getPaperInfo(db, 'aaaaaaaaaaaaaaaa')).toMatchObject({ status: 'failed', error: 'HTTP 429', bytes: 12345 });
    } finally {
      db.close();
    }
  });

  it('status 列里出现未知值时按 none 处理，不抛异常', () => {
    const db = openDb(':memory:');
    try {
      upsertPaperInfo(db, { itemId: 'bbbbbbbbbbbbbbbb', status: 'ready' });
      db.prepare("UPDATE papers SET status = 'weird' WHERE item_id = ?").run('bbbbbbbbbbbbbbbb');
      expect(getPaperInfo(db, 'bbbbbbbbbbbbbbbb').status).toBe('none');
    } finally {
      db.close();
    }
  });
});

describe('paper_annotations：高亮与笔记', () => {
  it('新增 → 列表 → 改笔记/颜色 → 删除 的完整闭环', () => {
    const db = openDb(':memory:');
    try {
      const created = addAnnotation(db, 'cccccccccccccccc', {
        page: 3,
        rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.02 }],
        text: ' KV cache 压缩率提升 4x ',
        color: '#7aa7f7',
      });
      expect(created.id).toMatch(/^anno-/);
      expect(created.text).toBe(' KV cache 压缩率提升 4x ');
      expect(created.note).toBe('');
      expect(created.color).toBe('#7aa7f7');

      expect(listAnnotations(db, 'cccccccccccccccc')).toHaveLength(1);

      const updated = updateAnnotation(db, 'cccccccccccccccc', created.id, {
        note: '这个方法可以抄到 KV offload 方案里',
        color: '#f2b357',
      });
      expect(updated).toMatchObject({ note: '这个方法可以抄到 KV offload 方案里', color: '#f2b357' });

      expect(removeAnnotation(db, 'cccccccccccccccc', created.id)).toBe(true);
      expect(removeAnnotation(db, 'cccccccccccccccc', created.id)).toBe(false);
      expect(listAnnotations(db, 'cccccccccccccccc')).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('按条目隔离：A 条目的标注不会被 B 条目改到/删到', () => {
    const db = openDb(':memory:');
    try {
      const a = addAnnotation(db, 'aaaaaaaaaaaaaaaa', { page: 1, rects: [{ x: 0, y: 0, w: 1, h: 1 }] });
      addAnnotation(db, 'bbbbbbbbbbbbbbbb', { page: 1, rects: [{ x: 0, y: 0, w: 1, h: 1 }] });

      expect(updateAnnotation(db, 'bbbbbbbbbbbbbbbb', a.id, { note: 'x' })).toBeUndefined();
      expect(removeAnnotation(db, 'bbbbbbbbbbbbbbbb', a.id)).toBe(false);
      expect(listAnnotations(db, 'aaaaaaaaaaaaaaaa')).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('rects JSON 损坏时退化为空数组，不让整页查询 500', () => {
    const db = openDb(':memory:');
    try {
      const created = addAnnotation(db, 'dddddddddddddddd', { page: 2, rects: [{ x: 0.5, y: 0.5, w: 0.1, h: 0.1 }] });
      db.prepare('UPDATE paper_annotations SET rects = ? WHERE id = ?').run('not-json', created.id);
      const list = listAnnotations(db, 'dddddddddddddddd');
      expect(list).toHaveLength(1);
      expect(list[0]?.rects).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe('pruneOrphanPapers：TTL 条目删除后的回收', () => {
  it('条目已删的 paper 行与标注一起清掉，存活条目的不受影响；返回孤儿 id 列表', () => {
    const db = openDb(':memory:');
    try {
      // 两条目的 externalId/url 必须不同：insertItems 会按 externalId 跨源去重，撞了会被丢弃
      insertItems(db, [
        makeItem('aaaaaaaaaaaaaaaa'),
        makeItem('bbbbbbbbbbbbbbbb', { url: 'https://arxiv.org/abs/2401.99999', externalId: '2401.99999' }),
      ]);
      upsertPaperInfo(db, { itemId: 'aaaaaaaaaaaaaaaa', status: 'ready', bytes: 1 });
      upsertPaperInfo(db, { itemId: 'bbbbbbbbbbbbbbbb', status: 'ready', bytes: 2 });
      addAnnotation(db, 'aaaaaaaaaaaaaaaa', { page: 1, rects: [{ x: 0, y: 0, w: 1, h: 1 }] });
      addAnnotation(db, 'bbbbbbbbbbbbbbbb', { page: 1, rects: [{ x: 0, y: 0, w: 1, h: 1 }] });

      // 模拟 TTL：删掉 a 条目
      db.prepare('DELETE FROM items WHERE id = ?').run('aaaaaaaaaaaaaaaa');

      const orphans = pruneOrphanPapers(db);
      expect(orphans).toEqual(['aaaaaaaaaaaaaaaa']);
      expect(getPaperInfo(db, 'aaaaaaaaaaaaaaaa').status).toBe('none');
      expect(getPaperInfo(db, 'bbbbbbbbbbbbbbbb').status).toBe('ready');
      expect(listAnnotations(db, 'aaaaaaaaaaaaaaaa')).toHaveLength(0);
      expect(listAnnotations(db, 'bbbbbbbbbbbbbbbb')).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('没有孤儿时返回空数组且不误删', () => {
    const db = openDb(':memory:');
    try {
      insertItems(db, [makeItem('aaaaaaaaaaaaaaaa')]);
      upsertPaperInfo(db, { itemId: 'aaaaaaaaaaaaaaaa', status: 'ready', bytes: 1 });
      expect(pruneOrphanPapers(db)).toEqual([]);
      expect(getPaperInfo(db, 'aaaaaaaaaaaaaaaa').status).toBe('ready');
    } finally {
      db.close();
    }
  });
});
