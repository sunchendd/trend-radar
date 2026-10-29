/**
 * 检索式巡检：把所有启用的巡检项跑一遍查新，落快照，给出趋势判读。
 *
 * 与「选题查新」的区别：选题查新是**事后**验证某条选题能不能做；
 * 巡检是**事前**盯住若干方向，命中数环比异动就是选题触发器。
 *
 * 集群环境下不要并发跑这个（会同时开多个浏览器登录智慧芽），由 CLI 或单实例定时任务触发。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { AppConfig } from './config.js';
import { runNovelty, type CommandRunner } from './ideas/novelty.js';
import { detectTrend, type TrendOutcome } from './ideas/trend.js';
import { history, listWatches, recordSnapshot, type Watch } from './store/watches.js';

export interface WatchTrend {
  watch: Watch;
  trend: TrendOutcome;
  history: { at: string; hits: number | null }[];
}

export interface SweepResult {
  at: string;
  checked: number;
  skipped: number;
  /** 命中数异动、值得据此出选题的巡检项 */
  alerts: WatchTrend[];
  trends: WatchTrend[];
  errors: { watchId: string; query: string; message: string }[];
}

export interface SweepOptions {
  /** 只跑这些巡检项（id）；不传则跑全部启用的 */
  watchIds?: string[];
  /** 注入假 CLI，测试用 */
  runCommand?: CommandRunner;
  now?: () => Date;
  /** 每条巡检项最多跑几条检索式（巡检项一般只有 1 条） */
  limit?: number;
}

/** 巡检项本身只有一个检索式，但 runNovelty 接受数组——保持同一条代码路径 */
export async function sweepWatches(
  config: AppConfig,
  db: DatabaseSync,
  options: SweepOptions = {},
): Promise<SweepResult> {
  const now = options.now ?? (() => new Date());
  const targets = listWatches(db, false).filter(
    (watch) => options.watchIds === undefined || options.watchIds.includes(watch.id),
  );

  const result: SweepResult = { at: now().toISOString(), checked: 0, skipped: 0, alerts: [], trends: [], errors: [] };
  if (targets.length === 0) return result;
  // 保留原始错误对象：上层要靠类型（NoveltyNotConfiguredError → 503）做映射，
  // 只留 message 会退化成 500，前端提示也跟着变模糊
  const failures: unknown[] = [];

  // 一条检索式一次 CLI 调用：智慧芽批检脚本本来就是"传多个检索式一次跑完"，
  // 但巡检项之间是独立方向，合并成一次调用会让单点失败拖垮全部，所以逐个跑。
  for (const watch of targets) {
    try {
      const records = await runNovelty(
        config,
        { queries: [watch.query], title: `巡检：${watch.query}` },
        [watch.query],
        {
          ...(options.runCommand ? { runCommand: options.runCommand } : {}),
          ...(options.limit ? { limit: options.limit } : {}),
          now,
        },
      );
      const first = records.find((record) => record.query === watch.query) ?? records[0];
      recordSnapshot(db, {
        watchId: watch.id,
        at: result.at,
        hits: first?.hits ?? null,
        topAssignees: first?.topAssignees ?? '',
      });
      result.checked += 1;
    } catch (error) {
      // 单个方向失败（登录掉了 / 页面改版）不能中断整轮巡检
      failures.push(error);
      result.errors.push({ watchId: watch.id, query: watch.query, message: (error as Error).message });
      result.skipped += 1;
    }
  }

  // 整轮全失败（例如 CLI 根本没配、登录全掉）不算"跑完了"：把它当错误抛出去，
  // 上层会映射成 503/500；只有部分失败才返回 200 + errors（那才是"跑了一部分"的诚实结果）。
  if (result.checked === 0 && targets.length > 0 && failures.length === targets.length) {
    throw failures[0];
  }

  for (const watch of listWatches(db, true).filter((item) => targets.some((t) => t.id === item.id))) {
    const snapshots = history(db, watch.id);
    const trend = detectTrend({ history: snapshots.map((item) => item.hits) });
    const entry: WatchTrend = {
      watch,
      trend,
      history: snapshots.map((item) => ({ at: item.at, hits: item.hits })),
    };
    result.trends.push(entry);
    if (trend.actionable) result.alerts.push(entry);
  }

  return result;
}
