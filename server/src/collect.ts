import { randomUUID } from 'node:crypto';

import type { AppConfig } from './config.js';
import { scoreItem, type ScoreOptions } from './score.js';
import { fetchAllSources, type FetchDeps, type SourceTiming } from './sources/index.js';
import { openDb } from './store/db.js';
import { insertItems, insertRun, listEnabledSources, pruneItems } from './store/queries.js';
import type { Item, RunRecord, Source } from './types.js';

/**
 * 一轮完整采集：抓取 → 打分 → 去重入库 → 记录 RunRecord。
 *
 * 这一层刻意只做「编排」，规则都在 score.ts / sources/*：
 * 编排层一旦混进业务规则，测试就只能连数据库一起测。
 */

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
 * 为什么不把这些字段塞进 RunRecord：RunRecord 是冻结契约（docs/api.md + web 共用），
 * 加字段要同步改契约；而「每源耗时」目前只有 CLI 和运行日志页想看，
 * 所以放在 RunRecord 之外的旁挂对象里，API 要用时自己取。
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

async function collectOnce(config: AppConfig, deps: CollectDeps): Promise<DetailedRun> {
  const startedAt = new Date().toISOString();
  const db = openDb(config.dataDir);

  try {
    const pool = deps.sources ?? listEnabledSources(db);
    const wanted = deps.sourceIds && deps.sourceIds.length > 0 ? new Set(deps.sourceIds) : undefined;
    const sources = wanted ? pool.filter((source) => wanted.has(source.id)) : pool;
    const result = await fetchAllSources(config, {
      fetch: deps.fetch,
      sources,
      limitPerSource: deps.limitPerSource ?? config.limitPerSource,
      concurrency: deps.concurrency,
      timeoutMs: deps.timeoutMs,
      hostPacingMs: deps.hostPacingMs,
      attempts: deps.attempts,
      now: deps.now,
    });

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

    const run: RunRecord = {
      id: randomUUID(),
      startedAt,
      finishedAt: new Date().toISOString(),
      sourceCount: result.sourceCount,
      added: inserted.added,
      fetched: result.fetched,
      // 按 sourceId 排序：并发抓取下错误顺序不确定，固定下来便于 diff 与前端展示稳定
      errors: [...result.errors].sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
    };

    insertRun(db, run);
    return { run, perSource: result.timings };
  } finally {
    db.close();
  }
}
