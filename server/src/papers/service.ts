/**
 * 论文 PDF 下载服务：幂等、限速、防伪造。
 *
 * 设计要点（每条都对应一个真实的失败模式）：
 * - 幂等：同一时刻同一 item 只有一个在飞下载（进程内 Map），重复请求直接复用同一个
 *   Promise —— 阅读器打开时会自动触发下载，连点/刷新不能叠加并发；
 * - 防伪造：只认魔数 `%PDF`，Content-Type 只是参考 —— 大量站点把 PDF 当
 *   application/octet-stream 发，也有反向代理把 404 页面配成 application/pdf；
 * - 限流友好：arXiv 对高频拉取限流（HTTP 429），下载失败要如实写进 papers.status，
 *   让 UI 展示可重试状态，而不是静默吞掉；
 * - 原子写：先写 `*.tmp` 再 rename，半截文件绝不可见（阅读器读到半截 PDF 会白屏）。
 */
import { existsSync, statSync, unlinkSync } from 'node:fs';
import { mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Item } from '../types.js';
import { getPaperInfo, pruneOrphanPapers, upsertPaperInfo, type PaperInfo } from '../store/papers.js';
import { extractPatentPdfLink, resolvePdfUrl } from './resolve.js';

/** 条目 id 是 sha1 hex 前 16 位；校验它同时挡住路径拼接注入 */
const ITEM_ID_PATTERN = /^[a-f0-9]{8,64}$/;
/** 单文件上限 64MB：arXiv 论文通常 1–10MB，上限只拦异常情况 */
const MAX_BYTES = 64 * 1024 * 1024;
/** 下载超时：arXiv 长尾实测 <20s，60s 足够宽裕 */
const DOWNLOAD_TIMEOUT_MS = 60_000;
/** Google Patents 页面抓取超时 */
const PAGE_TIMEOUT_MS = 20_000;

export class PaperError extends Error {
  readonly code: 'paper_no_pdf' | 'download_failed' | 'invalid_item_id';
  constructor(code: PaperError['code'], message: string) {
    super(message);
    this.name = 'PaperError';
    this.code = code;
  }
}

export interface PaperServiceOptions {
  /** PDF 存放目录（通常是 `<dataDir>/papers`） */
  papersDir: string;
  /** 注入 fetch（测试不出网） */
  fetchImpl?: typeof fetch;
  /** 注入下载完成回调（测试断言用） */
  onSettled?: (itemId: string, info: PaperInfo) => void;
}

export interface PaperFileRef {
  itemId: string;
  path: string;
  bytes: number;
}

export function createPaperService(db: unknown, options: PaperServiceOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  // db 在这里只透传给 store 层；类型收窄成 any 会传染，所以收成最小接口
  type Db = Parameters<typeof getPaperInfo>[0];
  const database = db as Db;

  // 进程内在飞下载表：key = itemId
  const inFlight = new Map<string, Promise<PaperInfo>>();

  const filePathOf = (itemId: string): string => join(options.papersDir, `${itemId}.pdf`);

  /** ready 且文件真的在磁盘上才算可读（文件被手动清掉时自愈） */
  function fileRef(itemId: string): PaperFileRef | undefined {
    const info = getPaperInfo(database, itemId);
    if (info.status !== 'ready') return undefined;
    const path = filePathOf(itemId);
    if (!existsSync(path)) return undefined;
    try {
      return { itemId, path, bytes: statSync(path).size };
    } catch {
      return undefined;
    }
  }

  async function download(itemId: string, item: Item): Promise<PaperInfo> {
    if (!ITEM_ID_PATTERN.test(itemId)) {
      throw new PaperError('invalid_item_id', `条目 id 非法：${itemId}`);
    }
    const existing = inFlight.get(itemId);
    if (existing) return existing;

    const task = (async (): Promise<PaperInfo> => {
      const ready = getPaperInfo(database, itemId);
      if (ready.status === 'ready' && fileRef(itemId)) return ready;

      const source = resolvePdfUrl(item);
      if (!source) {
        const failed = upsertPaperInfo(database, {
          itemId,
          status: 'failed',
          error: '没有可下载的 PDF：这条不是 arXiv 论文，链接也不是 PDF 或 Google Patents 页面',
        });
        options.onSettled?.(itemId, failed);
        return failed;
      }

      upsertPaperInfo(database, { itemId, status: 'pending', originUrl: source.pdfUrl, error: '' });
      try {
        let pdfUrl = source.pdfUrl;
        if (source.via === 'google-patents') {
          pdfUrl = await resolvePatentPdf(pdfUrl);
        }
        const bytes = await fetchToDisk(itemId, pdfUrl, filePathOf(itemId));
        const done = upsertPaperInfo(database, {
          itemId,
          status: 'ready',
          originUrl: pdfUrl,
          bytes,
          error: '',
          downloadedAt: new Date().toISOString(),
        });
        options.onSettled?.(itemId, done);
        return done;
      } catch (cause) {
        // 半截 tmp 文件必须清掉：留着会被下一次 rename 之外的任何逻辑误读
        const tmpPath = `${filePathOf(itemId)}.tmp`;
        try {
          if (existsSync(tmpPath)) unlinkSync(tmpPath);
        } catch {
          // 清理失败不掩盖原始错误
        }
        const message =
          cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '下载失败';
        const failed = upsertPaperInfo(database, { itemId, status: 'failed', error: message });
        options.onSettled?.(itemId, failed);
        return failed;
      }
    })().finally(() => {
      inFlight.delete(itemId);
    });

    inFlight.set(itemId, task);
    return task;
  }

  async function resolvePatentPdf(pageUrl: string): Promise<string> {
    const res = await fetchImpl(pageUrl, { signal: AbortSignal.timeout(PAGE_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`Google Patents 页面请求失败：HTTP ${res.status}`);
    const html = await res.text();
    const pdfUrl = extractPatentPdfLink(html);
    if (!pdfUrl) throw new Error('Google Patents 页面里没有找到 PDF 下载链接（页面结构可能已变化）');
    return pdfUrl;
  }

  async function fetchToDisk(itemId: string, pdfUrl: string, dest: string): Promise<number> {
    let res: Response;
    try {
      res = await fetchImpl(pdfUrl, {
        redirect: 'follow',
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        headers: { 'user-agent': 'trend-radar-paper-reader/0.1 (local research dashboard)' },
      });
    } catch (cause) {
      throw new Error(
        `下载请求失败：${cause instanceof Error ? cause.message : String(cause)}（arXiv 偶发限流，稍后重试即可）`,
      );
    }
    if (!res.ok) {
      throw new Error(`下载失败：HTTP ${res.status}（${pdfUrl}）`);
    }

    // 流式落盘 + 大小上限：边收边断，不要先 buffer 整个文件
    const tmpPath = `${dest}.tmp`;
    const chunks: Buffer[] = [];
    let total = 0;
    const reader = res.body?.getReader();
    if (!reader) throw new Error('下载响应没有可读流');
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel();
        throw new Error(`文件超过 64MB 上限，疑似不是论文 PDF`);
      }
      chunks.push(Buffer.from(value));
    }

    const buffer = Buffer.concat(chunks);
    // 魔数校验：PDF 一定以 %PDF 开头；HTML 报错页 / 限流页在这里被拦下
    if (buffer.length < 5 || buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new Error('响应内容不是 PDF（魔数校验失败），可能被限流或链接失效');
    }
    await mkdir(options.papersDir, { recursive: true });
    await writeFile(tmpPath, buffer);
    await rename(tmpPath, dest);
    return buffer.length;
  }

  return {
    /** 幂等触发下载；返回最终状态（ready/failed） */
    download,
    /** 当前状态（不触发下载）；进程重启留下的僵尸 pending 自动改判为 failed */
    status: (itemId: string): PaperInfo => {
      const info = getPaperInfo(database, itemId);
      if (info.status === 'pending' && !inFlight.has(itemId)) {
        return upsertPaperInfo(database, {
          itemId,
          status: 'failed',
          error: '上次下载中断（服务重启），可重试',
        });
      }
      return info;
    },
    /** ready 时的文件引用；文件缺失返回 undefined */
    file: fileRef,
    /** 删除 PDF 文件（TTL 清理用） */
    removeFile: async (itemId: string): Promise<void> => {
      const path = filePathOf(itemId);
      try {
        await unlink(path);
      } catch {
        // 文件本来就不存在：目标已达成
      }
    },
    /** 清理孤儿：条目已删的 paper 行 + 对应文件 */
    pruneOrphans: async (): Promise<number> => {
      const orphanIds = pruneOrphanPapers(database);
      for (const id of orphanIds) await unlinkQuiet(join(options.papersDir, `${id}.pdf`));
      return orphanIds.length;
    },
    stat: async (itemId: string) => {
      try {
        const s = await stat(filePathOf(itemId));
        return s.size;
      } catch {
        return null;
      }
    },
  };
}

async function unlinkQuiet(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // 已不存在
  }
}

export type PaperService = ReturnType<typeof createPaperService>;
