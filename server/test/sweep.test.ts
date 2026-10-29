import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../src/config.js';
import { detectTrend, TREND_THRESHOLDS } from '../src/ideas/trend.js';
import { sweepWatches } from '../src/sweep.js';
import { addWatch, history, listWatches, recordSnapshot, removeWatch, setWatchEnabled } from '../src/store/watches.js';
import { openDb } from '../src/store/db.js';

describe('巡检趋势判读', () => {
  it('只有一次快照时是基线，不给环比结论', () => {
    const out = detectTrend({ history: [7] });
    expect(out.level).toBe('baseline');
    expect(out.deltaPct).toBeNull();
    expect(out.actionable).toBe(false);
    expect(out.headline).toContain('基线');
  });

  it('涨幅 ≥30% 且命中 ≥5 判为升温，并且 actionable', () => {
    const out = detectTrend({ history: [10, 14] });
    expect(out.level).toBe('surge');
    expect(out.deltaPct).toBeCloseTo(0.4, 5);
    expect(out.actionable).toBe(true);
    expect(out.headline).toContain('+40%');
  });

  it('涨幅够但基数太小（<5）不算升温，避免 1→2 就报警', () => {
    const out = detectTrend({ history: [1, 2] });
    expect(out.level).toBe('warm');
    expect(out.actionable).toBe(false);
  });

  it('从 0 到有命中判为新方向冒头，而不是"涨幅无穷大"', () => {
    const out = detectTrend({ history: [0, 4] });
    expect(out.level).toBe('new-front');
    expect(out.deltaPct).toBeNull();
    expect(out.actionable).toBe(true);
    expect(out.headline).toContain('从 0 涨到 4');
  });

  it('连续零命中要提示先怀疑检索式，而不是宣布空白', () => {
    const out = detectTrend({ history: [0, 0] });
    expect(out.level).toBe('flat');
    expect(out.headline).toContain('先怀疑检索式');
    expect(out.actionable).toBe(false);
  });

  it('跌幅 ≤-25% 判为降温', () => {
    const out = detectTrend({ history: [20, 12] });
    expect(out.level).toBe('cool');
    expect(out.headline).toContain('-40%');
  });

  it('解析失败(null)的记录被跳过，不会把趋势判成暴跌', () => {
    const out = detectTrend({ history: [30, null, 33] });
    // +10% 落在平稳带；关键是 previous=30 而不是 0（否则会算成 +3300% 或暴跌）
    expect(out.level).toBe('flat');
    expect(out.previous).toBe(30);
    expect(out.latest).toBe(33);
    expect(out.deltaPct).toBeCloseTo(0.1, 5);
  });

  it('全是解析失败时明确说没有有效数据', () => {
    const out = detectTrend({ history: [null, null] });
    expect(out.level).toBe('baseline');
    expect(out.latest).toBeNull();
  });

  it('阈值常量被导出，UI 与测试共用同一份口径', () => {
    expect(TREND_THRESHOLDS.SURGE_PCT).toBe(0.3);
    expect(TREND_THRESHOLDS.SURGE_MIN_HITS).toBe(5);
  });
});

describe('巡检项存储', () => {
  let dir: string;
  let db: DatabaseSync;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tr-watch-'));
    db = openDb(dir);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('新增、去重、停用、删除', () => {
    const a = addWatch(db, { query: '投机解码 草稿 重建', note: '主线' });
    const b = addWatch(db, { query: '投机解码 草稿 重建' });
    expect(b.id).toBe(a.id); // 同检索式不重复建
    expect(listWatches(db)).toHaveLength(1);

    setWatchEnabled(db, a.id, false);
    expect(listWatches(db)).toHaveLength(0);
    expect(listWatches(db, true)).toHaveLength(1);

    expect(removeWatch(db, a.id)).toBe(true);
    expect(listWatches(db, true)).toHaveLength(0);
  });

  it('快照按时间升序返回，且 null 命中不会被当成 0', () => {
    const watch = addWatch(db, { query: 'KV压缩 传输 重建' });
    recordSnapshot(db, { watchId: watch.id, at: '2026-10-01T00:00:00.000Z', hits: 6, topAssignees: 'A:6' });
    recordSnapshot(db, { watchId: watch.id, at: '2026-10-08T00:00:00.000Z', hits: null, topAssignees: '' });
    recordSnapshot(db, { watchId: watch.id, at: '2026-10-15T00:00:00.000Z', hits: 9, topAssignees: 'B:9' });
    const rows = history(db, watch.id);
    expect(rows.map((row) => row.hits)).toEqual([6, null, 9]);
    expect(rows[2]?.topAssignees).toBe('B:9');
  });

  it('空检索式直接拒绝', () => {
    expect(() => addWatch(db, { query: '   ' })).toThrow(/不能为空/);
  });
});

describe('巡检执行', () => {
  let dir: string;
  let db: DatabaseSync;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tr-sweep-'));
    db = openDb(dir);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const config = loadConfig({ TREND_RADAR_DATA_DIR: ':memory:', ZHY_COMMAND: '/bin/echo' });

  it('跑一轮落快照并给出趋势；命中数上升时进 alerts', async () => {
    const watch = addWatch(db, { query: '投机解码 草稿 重建' });
    // 先造一个基线
    recordSnapshot(db, { watchId: watch.id, at: '2026-10-20T00:00:00.000Z', hits: 4, topAssignees: 'X:4' });

    const fakeRunner = async () => ({
      stdout: JSON.stringify([{ q: '投机解码 草稿 重建', count: 9, apps: ['华为:5'], pats: ['CN1 | t'] }]),
      stderr: '',
      code: 0,
    });

    const res = await sweepWatches(config, db, {
      runCommand: fakeRunner,
      now: () => new Date('2026-10-27T00:00:00.000Z'),
    });

    expect(res.checked).toBe(1);
    expect(res.errors).toHaveLength(0);
    expect(res.trends).toHaveLength(1);
    expect(res.trends[0]?.trend.level).toBe('surge');
    expect(res.alerts).toHaveLength(1);
    expect(history(db, watch.id).map((row) => row.hits)).toEqual([4, 9]);
  });

  it('单个巡检项失败不中断整轮（登录掉了的常见情形）', async () => {
    const failing = addWatch(db, { query: '方向 A B C' });
    const working = addWatch(db, { query: '方向 D E F' });

    // 按检索式决定失败，而不是按调用次序：listWatches 的排序在 created_at 相同时不保证稳定，
    // 之前按 call===1 写会导致行为依赖提交顺序（CI 上就翻车了）。
    const flakyRunner = async (_cmd: string, args: string[]) => {
      const query = args.join(' ');
      if (query.includes('方向 A B C')) throw new Error('登录未完成');
      return { stdout: JSON.stringify([{ q: '方向 D E F', count: 3, apps: [], pats: [] }]), stderr: '', code: 0 };
    };

    const res = await sweepWatches(config, db, { runCommand: flakyRunner });
    expect(res.checked).toBe(1);
    expect(res.skipped).toBe(1);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]?.watchId).toBe(failing.id);
    expect(res.errors[0]?.message).toContain('登录未完成');
    // 失败的方向不写快照，成功的方向照常落库
    expect(history(db, failing.id)).toHaveLength(0);
    expect(history(db, working.id).map((row) => row.hits)).toEqual([3]);
  });

  it('没有巡检项时直接返回空结果，不启动任何外部调用', async () => {
    let called = false;
    const res = await sweepWatches(config, db, {
      runCommand: async () => {
        called = true;
        return { stdout: '[]', stderr: '', code: 0 };
      },
    });
    expect(called).toBe(false);
    expect(res.checked).toBe(0);
  });
});
