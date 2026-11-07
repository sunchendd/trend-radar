/**
 * 论文阅读器的持久化：PDF 下载状态 + 高亮/笔记标注。
 *
 * 为什么单独一个文件、不加进主 schema 迁移（同 watches.ts 的先例）：
 * 这个能力是后加的，用 `CREATE TABLE IF NOT EXISTS` 自带建表，不动 user_version，
 * 也不影响老库启动。papers 表一行对应一个条目的 PDF 文件；
 * paper_annotations 一行对应一段高亮/笔记（按页 + 归一化矩形存储）。
 */
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/** 一条条目的 PDF 下载状态 */
export interface PaperInfo {
  itemId: string;
  /** none = 从未下载；pending = 在飞；ready = 可读；failed = 失败（error 有原因） */
  status: 'none' | 'pending' | 'ready' | 'failed';
  /** 解析出的 PDF 来源地址（resolved） */
  originUrl: string;
  /** 文件大小（字节）；ready 时有效 */
  bytes: number | null;
  /** 失败原因（面向用户的中文短句） */
  error: string;
  /** 下载完成时间（ISO）；从未成功为 null */
  downloadedAt: string | null;
  updatedAt: string;
}

/** 一段高亮 / 笔记 */
export interface PaperAnnotation {
  id: string;
  itemId: string;
  /** PDF 页码（1 起） */
  page: number;
  /** 选中区域，归一化到页面尺寸的矩形 [{x,y,w,h}]，随缩放不变 */
  rects: { x: number; y: number; w: number; h: number }[];
  /** 选中时的原文快照（跳转定位与导出用） */
  text: string;
  /** 用户笔记；'' = 纯高亮 */
  note: string;
  /** 高亮色（前端色值原样存） */
  color: string;
  createdAt: string;
  updatedAt: string;
}

export interface AnnotationInput {
  page: number;
  rects: { x: number; y: number; w: number; h: number }[];
  text?: string;
  note?: string;
  color?: string;
}

/** 高亮色只认这份白名单：自由色值会把 UI 搞花，也省一层校验逻辑 */
export const ANNOTATION_COLORS = ['#f2b357', '#35e7c5', '#7aa7f7', '#ff8fa3', '#c3a6ff'] as const;

function ensureSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS papers (
      item_id      TEXT PRIMARY KEY,
      status       TEXT NOT NULL DEFAULT 'none',
      origin_url   TEXT NOT NULL DEFAULT '',
      bytes        INTEGER,
      error        TEXT NOT NULL DEFAULT '',
      downloaded_at TEXT,
      updated_at   TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS paper_annotations (
      id         TEXT PRIMARY KEY,
      item_id    TEXT NOT NULL,
      page       INTEGER NOT NULL,
      rects      TEXT NOT NULL DEFAULT '[]',
      text       TEXT NOT NULL DEFAULT '',
      note       TEXT NOT NULL DEFAULT '',
      color      TEXT NOT NULL DEFAULT '#f2b357',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_paper_annotations_item ON paper_annotations (item_id, page);
  `);
}

// ---------------------------------------------------------------- papers

const nowIso = (): string => new Date().toISOString();

function mapPaper(row: Record<string, unknown> | undefined, itemId: string): PaperInfo {
  if (!row) {
    return { itemId, status: 'none', originUrl: '', bytes: null, error: '', downloadedAt: null, updatedAt: '' };
  }
  const status = typeof row['status'] === 'string' ? row['status'] : 'none';
  return {
    itemId,
    status: status === 'pending' || status === 'ready' || status === 'failed' ? status : 'none',
    originUrl: typeof row['origin_url'] === 'string' ? row['origin_url'] : '',
    bytes: typeof row['bytes'] === 'number' ? row['bytes'] : null,
    error: typeof row['error'] === 'string' ? row['error'] : '',
    downloadedAt: typeof row['downloaded_at'] === 'string' ? row['downloaded_at'] : null,
    updatedAt: typeof row['updated_at'] === 'string' ? row['updated_at'] : '',
  };
}

export function getPaperInfo(db: DatabaseSync, itemId: string): PaperInfo {
  ensureSchema(db);
  const row = db.prepare('SELECT * FROM papers WHERE item_id = ?').get(itemId) as
    | Record<string, unknown>
    | undefined;
  return mapPaper(row, itemId);
}

export function upsertPaperInfo(db: DatabaseSync, info: Partial<PaperInfo> & { itemId: string }): PaperInfo {
  ensureSchema(db);
  const current = getPaperInfo(db, info.itemId);
  const next: PaperInfo = {
    itemId: info.itemId,
    status: info.status ?? current.status,
    originUrl: info.originUrl ?? current.originUrl,
    bytes: info.bytes ?? current.bytes,
    error: info.error ?? current.error,
    downloadedAt: info.downloadedAt ?? current.downloadedAt,
    updatedAt: nowIso(),
  };
  db.prepare(
    `INSERT INTO papers (item_id, status, origin_url, bytes, error, downloaded_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(item_id) DO UPDATE SET
       status = excluded.status, origin_url = excluded.origin_url, bytes = excluded.bytes,
       error = excluded.error, downloaded_at = excluded.downloaded_at, updated_at = excluded.updated_at`,
  ).run(
    next.itemId,
    next.status,
    next.originUrl,
    next.bytes,
    next.error,
    next.downloadedAt,
    next.updatedAt,
  );
  return next;
}

/**
 * 清掉「条目已被 TTL 删除」的 paper 行，返回孤儿 item_id 列表（文件删除由调用方做：
 * 存储层只碰 sqlite，不碰文件系统，职责分开才好测）。
 */
export function pruneOrphanPapers(db: DatabaseSync): string[] {
  ensureSchema(db);
  const orphans = db
    .prepare('SELECT p.item_id FROM papers p LEFT JOIN items i ON i.id = p.item_id WHERE i.id IS NULL')
    .all() as unknown as { item_id: string }[];
  if (orphans.length === 0) return [];
  db.prepare(
    `DELETE FROM paper_annotations WHERE item_id NOT IN (SELECT id FROM items)`,
  ).run();
  db.prepare(`DELETE FROM papers WHERE item_id NOT IN (SELECT id FROM items)`).run();
  return orphans.map((row) => row.item_id);
}

// ---------------------------------------------------------------- annotations

function mapAnnotation(row: Record<string, unknown>): PaperAnnotation {
  let rects: PaperAnnotation['rects'] = [];
  try {
    const parsed: unknown = JSON.parse(typeof row['rects'] === 'string' ? row['rects'] : '[]');
    if (Array.isArray(parsed)) {
      rects = parsed
        .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
        .map((r) => ({
          x: Number(r['x']) || 0,
          y: Number(r['y']) || 0,
          w: Number(r['w']) || 0,
          h: Number(r['h']) || 0,
        }));
    }
  } catch {
    rects = [];
  }
  return {
    id: String(row['id'] ?? ''),
    itemId: String(row['item_id'] ?? ''),
    page: Number(row['page']) || 1,
    rects,
    text: typeof row['text'] === 'string' ? row['text'] : '',
    note: typeof row['note'] === 'string' ? row['note'] : '',
    color: typeof row['color'] === 'string' ? row['color'] : ANNOTATION_COLORS[0],
    createdAt: typeof row['created_at'] === 'string' ? row['created_at'] : '',
    updatedAt: typeof row['updated_at'] === 'string' ? row['updated_at'] : '',
  };
}

export function listAnnotations(db: DatabaseSync, itemId: string): PaperAnnotation[] {
  ensureSchema(db);
  const rows = db
    .prepare('SELECT * FROM paper_annotations WHERE item_id = ? ORDER BY page ASC, created_at ASC')
    .all(itemId) as unknown as Record<string, unknown>[];
  return rows.map(mapAnnotation);
}

export function newAnnotationId(): string {
  return `anno-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

export function addAnnotation(db: DatabaseSync, itemId: string, input: AnnotationInput): PaperAnnotation {
  ensureSchema(db);
  const now = nowIso();
  const annotation: PaperAnnotation = {
    id: newAnnotationId(),
    itemId,
    page: Math.max(1, Math.trunc(input.page)),
    rects: input.rects,
    text: input.text ?? '',
    note: input.note ?? '',
    color: input.color ?? ANNOTATION_COLORS[0],
    createdAt: now,
    updatedAt: now,
  };
  db.prepare(
    `INSERT INTO paper_annotations (id, item_id, page, rects, text, note, color, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    annotation.id,
    annotation.itemId,
    annotation.page,
    JSON.stringify(annotation.rects),
    annotation.text,
    annotation.note,
    annotation.color,
    annotation.createdAt,
    annotation.updatedAt,
  );
  return annotation;
}

export function updateAnnotation(
  db: DatabaseSync,
  itemId: string,
  annotationId: string,
  patch: { note?: string; color?: string },
): PaperAnnotation | undefined {
  ensureSchema(db);
  const rows = db
    .prepare('SELECT * FROM paper_annotations WHERE id = ? AND item_id = ?')
    .get(annotationId, itemId) as unknown as Record<string, unknown> | undefined;
  if (!rows) return undefined;
  const current = mapAnnotation(rows);
  const next: PaperAnnotation = {
    ...current,
    note: patch.note ?? current.note,
    color: patch.color ?? current.color,
    updatedAt: nowIso(),
  };
  db.prepare('UPDATE paper_annotations SET note = ?, color = ?, updated_at = ? WHERE id = ?').run(
    next.note,
    next.color,
    next.updatedAt,
    annotationId,
  );
  return next;
}

export function removeAnnotation(db: DatabaseSync, itemId: string, annotationId: string): boolean {
  ensureSchema(db);
  return (
    Number(
      db.prepare('DELETE FROM paper_annotations WHERE id = ? AND item_id = ?').run(annotationId, itemId).changes,
    ) > 0
  );
}
