import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import type { AppConfig } from './config.js';
import { scoreItem, type ScoreOptions } from './score.js';
import {
  fetchAllSources,
  type FetchAllResult,
  type FetchDeps,
  type SourceTiming,
} from './sources/index.js';
import type { RawItem } from './sources/raw.js';
import { openDb } from './store/db.js';
import { insertItems, insertRun, listEnabledSources, pruneItems } from './store/queries.js';
import type { Item, RunRecord, Source } from './types.js';
import { createPaperService } from './papers/service.js';

/**
 * 一轮完整采集：抓取 → 打分 → 去重入库 → 记录 RunRecord。
 *
 * 这一层刻意只做「编排」，规则都在 score.ts / sources/*：
 * 编排层一旦混进业务规则，测试就只能连数据库一起测。
 */

/** arXiv 官方限速 1req/3s：串行抓取相邻请求的最小间隔（测试可用 hostPacingMs 覆盖调小） */
const ARXIV_HOST_PACING_MS = 3000;

export interface CollectDeps extends Omit<FetchDeps, 'sources'> {
  /** 覆盖源清单（默认取数据库里 enabled 的源） */
  sources?: readonly Source[];
  /** 只抓指定源（`POST /api/collect { sourceIds }` 用）；空数组/不传 = 全部 enabled */
  sourceIds?: readonly string[];
  /** 打分参数（测试注入固定 now / 自定义词表） */
  scoreOptions?: ScoreOptions;
}

/**
 * 一次采集的完整诊断。
 *
 * perSource 自 v2 起也进 RunRecord（可选字段，老数据没有），因为运行日志页要回答
 * 「这次采集为什么慢」——只在 CLI 里旁挂等于用户看不到。
 */
export interface DetailedRun {
  run: RunRecord;
  /** 每源耗时/条数，按 sourceId 排序 */
  perSource: SourceTiming[];
}

/** 同一进程内同一数据目录只允许一轮采集在跑：API 重复触发时复用同一个 promise */
const inflight = new Map<string, Promise<DetailedRun>>();

export async function runCollect(config: AppConfig, deps: CollectDeps = {}): Promise<RunRecord> {
  return (await runCollectDetailed(config, deps)).run;
}

export function runCollectDetailed(config: AppConfig, deps: CollectDeps = {}): Promise<DetailedRun> {
  const key = config.dataDir;
  const running = inflight.get(key);
  if (running) return running;

  const promise = collectOnce(config, deps).finally(() => {
    // 只清理自己，避免把后来者的 promise 误删
    if (inflight.get(key) === promise) inflight.delete(key);
  });
  inflight.set(key, promise);
  return promise;
}

/**
 * 把分片抓取的结果合并回一份 FetchAllResult。
 * 条目按「调用方给的源顺序」重排（并发下子结果完成顺序不定），errors/timings
 * 保持各自排序规则，与单次 fetchAllSources 的输出形状完全一致。
 */
function mergeFetchResults(parts: (FetchAllResult | null)[], order: readonly Source[]): FetchAllResult {
  const valid = parts.filter((part): part is FetchAllResult => part !== null);
  const bySource = new Map<string, RawItem[]>();
  for (const part of valid) {
    for (const raw of part.items) {
      const bucket = bySource.get(raw.sourceId) ?? [];
      bucket.push(raw);
      bySource.set(raw.sourceId, bucket);
    }
  }
  return {
    items: order.flatMap((source) => bySource.get(source.id) ?? []),
    errors: valid.flatMap((part) => part.errors),
    fetched: order.reduce((sum, source) => sum + (bySource.get(source.id)?.length ?? 0), 0),
    sourceCount: valid.reduce((sum, part) => sum + part.sourceCount, 0),
    timings: valid.flatMap((part) => part.timings).sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
  };
}

/**
 * 分区抓取：arXiv 源（kind=arxiv）串行执行（concurrency=1）且相邻请求间隔 ≥3s
 * （官方限速 1req/3s；并发 + 同 host 打点实测 3 个源全部 429/超时），其余源维持
 * 原并发行为。两个分区并行跑，互不拖慢；429 的 5s 重试在 sources/index.ts 里统一处理。
 */
async function fetchSourcesForCollect(
  config: AppConfig,
  deps: CollectDeps,
  sources: readonly Source[],
): Promise<FetchAllResult> {
  const base = {
    fetch: deps.fetch,
    limitPerSource: deps.limitPerSource ?? config.limitPerSource,
    limitPerNewsSource: deps.limitPerNewsSource ?? config.limitPerNewsSource,
    timeoutMs: deps.timeoutMs,
    hostTimeoutsMs: deps.hostTimeoutsMs,
    attempts: deps.attempts,
    sleep: deps.sleep,
    now: deps.now,
  };
  const arxivSources = sources.filter((source) => source.kind === 'arxiv');
  const otherSources = sources.filter((source) => source.kind !== 'arxiv');

  const [arxivResult, otherResult] = await Promise.all([
    arxivSources.length > 0
      ? fetchAllSources(config, {
          ...base,
          sources: arxivSources,
          concurrency: 1,
          hostPacingMs: deps.hostPacingMs ?? { 'export.arxiv.org': ARXIV_HOST_PACING_MS },
        })
      : null,
    otherSources.length > 0
      ? fetchAllSources(config, {
          ...base,
          sources: otherSources,
          concurrency: deps.concurrency,
          hostPacingMs: deps.hostPacingMs,
        })
      : null,
  ]);

  return mergeFetchResults([arxivResult, otherResult], sources);
}

async function collectOnce(config: AppConfig, deps: CollectDeps): Promise<DetailedRun> {
  const startedAt = new Date().toISOString();
  const db = openDb(config.dataDir);

  try {
    const pool = deps.sources ?? listEnabledSources(db);
    const wanted = deps.sourceIds && deps.sourceIds.length > 0 ? new Set(deps.sourceIds) : undefined;
    const sources = wanted ? pool.filter((source) => wanted.has(source.id)) : pool;
    const result = await fetchSourcesForCollect(config, deps, sources);

    const weightBySource = new Map(sources.map((source) => [source.id, source.weight]));
    // 理由文案要用源展示名（「arXiv · 投机解码 +10」比「源 weight=2.4」可读得多）
    const labelBySource = new Map(sources.map((source) => [source.id, source.label]));
    const now = deps.scoreOptions?.now ?? new Date();
    const fetchedAt = now.toISOString();

    const items: Item[] = [];
    for (const raw of result.items) {
      const { score, reasons, keywords } = scoreItem(
        {
          title: raw.title,
          summary: raw.summary,
          kind: raw.kind,
          sourceId: raw.sourceId,
          sourceWeight: weightBySource.get(raw.sourceId) ?? 1,
          sourceLabel: labelBySource.get(raw.sourceId),
          publishedAt: raw.publishedAt,
          fetchedAt,
        },
        // 词表可整体替换，便于某个垂直方向复用采集管线
        { now, keywords: deps.scoreOptions?.keywords },
      );

      // 低于阈值不入库（config.minKeepScore 默认 0 = 全留），省磁盘也省后续 LLM 的 token
      if (score < config.minKeepScore) continue;

      const item: Item = {
        id: raw.id,
        sourceId: raw.sourceId,
        kind: raw.kind,
        title: raw.title,
        url: raw.url,
        summary: raw.summary,
        authors: raw.authors,
        publishedAt: raw.publishedAt,
        fetchedAt,
        score,
        scoreReasons: reasons,
        keywords,
      };
      if (raw.externalId) item.externalId = raw.externalId;
      items.push(item);
    }

    const inserted = insertItems(db, items);
    // TTL 清理：顺手做，条数不进 RunRecord（errors 是「源失败」语义，混进清理会让健康采集显示成有错）
    pruneItems(db, config.ttlDays, now);
    // 论文 PDF 的孤儿清理（条目已删 → paper 行 + 文件一起回收）；文件 IO 异步做，不阻塞 run 落库
    void createPaperService(db, { papersDir: join(config.dataDir, 'papers') })
      .pruneOrphans()
      .catch(() => {
        // 清理失败不影响采集主流程，下一轮还会再试
      });

    const run: RunRecord = {
      id: randomUUID(),
      startedAt,
      finishedAt: new Date().toISOString(),
      sourceCount: result.sourceCount,
      added: inserted.added,
      fetched: result.fetched,
      // 按 sourceId 排序：并发抓取下错误顺序不确定，固定下来便于 diff 与前端展示稳定
      errors: [...result.errors].sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
      // 每源耗时/条数一并落库（v2 起 RunRecord 有 perSource；老库该列为 NULL，读出来是 undefined）
      perSource: [...result.timings].sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
    };

    insertRun(db, run);
    return { run, perSource: result.timings };
  } finally {
    db.close();
  }
}
