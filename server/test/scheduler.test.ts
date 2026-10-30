/**
 * 调度器测试：纯函数优先（时间计算必须确定，不靠等待），
 * 只有「定时器真的会触发 / stop 真的清干净」这两件事需要真实时钟，用毫秒级间隔完成。
 */
import { describe, expect, it } from 'vitest';
import { nextDailyRunAt, nextRunAt, refreshModeOf, startScheduler } from '../src/scheduler.js';

/** 用本地时间构造，避免断言依赖机器时区（函数本身就是「服务器本地时区」语义） */
const at = (year: number, month: number, day: number, hour: number, minute: number): Date =>
  new Date(year, month - 1, day, hour, minute, 0, 0);

const waitFor = async (predicate: () => boolean, timeoutMs = 3000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const idle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('nextDailyRunAt', () => {
  it('当天还没到 → 就是今天那个时刻', () => {
    const next = nextDailyRunAt(at(2026, 10, 30, 9, 41), '18:00');
    expect(next?.getFullYear()).toBe(2026);
    expect(next?.getMonth()).toBe(9);
    expect(next?.getDate()).toBe(30);
    expect(next?.getHours()).toBe(18);
    expect(next?.getMinutes()).toBe(0);
    expect(next?.getSeconds()).toBe(0);
  });

  it('当天已过 → 次日同一时刻', () => {
    const next = nextDailyRunAt(at(2026, 10, 30, 9, 41), '08:00');
    expect(next?.getDate()).toBe(31);
    expect(next?.getHours()).toBe(8);
  });

  it('正好等于现在也算「已过」→ 次日（否则会立刻触发一次）', () => {
    const next = nextDailyRunAt(at(2026, 10, 30, 9, 41), '09:41');
    expect(next?.getDate()).toBe(31);
    expect(next?.getHours()).toBe(9);
    expect(next?.getMinutes()).toBe(41);
  });

  it('跨月边界按日历进位', () => {
    const next = nextDailyRunAt(at(2026, 10, 31, 23, 30), '00:30');
    expect(next?.getMonth()).toBe(10); // 11 月
    expect(next?.getDate()).toBe(1);
    expect(next?.getHours()).toBe(0);
  });

  it('24:00 与各种非法写法返回 null', () => {
    const now = at(2026, 10, 30, 9, 41);
    for (const bad of ['24:00', '25:00', '12:60', '-1:00', '', '  ', 'abc', '8', '08:5', '08:05:00']) {
      expect(nextDailyRunAt(now, bad), `"${bad}" 应该判非法`).toBeNull();
    }
  });

  it('容忍一位小时与首尾空格（前端可能不补零）', () => {
    const next = nextDailyRunAt(at(2026, 10, 30, 9, 41), ' 18:5 ');
    // '18:5' 分钟只有一位 → 非法；' 18:05 ' 才合法
    expect(next).toBeNull();
    const ok = nextDailyRunAt(at(2026, 10, 30, 9, 41), ' 8:05 ');
    expect(ok?.getHours()).toBe(8);
    expect(ok?.getMinutes()).toBe(5);
    expect(ok?.getDate()).toBe(31);
  });
});

describe('nextRunAt（优先级）', () => {
  const now = at(2026, 10, 30, 9, 41);

  it('开启每日定时时以每日为准，忽略 collectMinutes', () => {
    const next = nextRunAt({ dailyRefreshEnabled: true, dailyRefreshAt: '18:00', collectMinutes: 30 }, now);
    expect(next?.getHours()).toBe(18);
    expect(next?.getDate()).toBe(30);
  });

  it('关闭每日定时后回落到间隔采集', () => {
    const next = nextRunAt({ dailyRefreshEnabled: false, dailyRefreshAt: '18:00', collectMinutes: 30 }, now);
    expect(next?.getTime()).toBe(now.getTime() + 30 * 60_000);
  });

  it('间隔为 0 且每日关闭 → 不自动采集', () => {
    expect(nextRunAt({ dailyRefreshEnabled: false, dailyRefreshAt: '18:00', collectMinutes: 0 }, now)).toBeNull();
  });

  it('每日开着但时间非法 → 回落到间隔；间隔也 0 才真正停', () => {
    const fallback = nextRunAt({ dailyRefreshEnabled: true, dailyRefreshAt: '24:00', collectMinutes: 15 }, now);
    expect(fallback?.getTime()).toBe(now.getTime() + 15 * 60_000);
    expect(nextRunAt({ dailyRefreshEnabled: true, dailyRefreshAt: '24:00', collectMinutes: 0 }, now)).toBeNull();
  });
});

describe('refreshModeOf（与 nextRunAt 同源）', () => {
  it('三态：daily / interval / off', () => {
    expect(refreshModeOf({ dailyRefreshEnabled: true, dailyRefreshAt: '08:00', collectMinutes: 30 })).toBe('daily');
    expect(refreshModeOf({ dailyRefreshEnabled: false, dailyRefreshAt: '08:00', collectMinutes: 30 })).toBe('interval');
    expect(refreshModeOf({ dailyRefreshEnabled: false, dailyRefreshAt: '08:00', collectMinutes: 0 })).toBe('off');
  });

  it('每日时间非法时 mode 跟着回落，避免「界面说每日、实际按间隔跑」', () => {
    expect(refreshModeOf({ dailyRefreshEnabled: true, dailyRefreshAt: '24:00', collectMinutes: 15 })).toBe('interval');
    expect(refreshModeOf({ dailyRefreshEnabled: true, dailyRefreshAt: '24:00', collectMinutes: 0 })).toBe('off');
  });

  it('mode 与 nextRunAt 的结果严格一致', () => {
    const now = at(2026, 10, 30, 9, 41);
    const cases = [
      { dailyRefreshEnabled: true, dailyRefreshAt: '18:00', collectMinutes: 30 },
      { dailyRefreshEnabled: false, dailyRefreshAt: '18:00', collectMinutes: 30 },
      { dailyRefreshEnabled: false, dailyRefreshAt: '18:00', collectMinutes: 0 },
      { dailyRefreshEnabled: true, dailyRefreshAt: '24:00', collectMinutes: 15 },
      { dailyRefreshEnabled: true, dailyRefreshAt: '24:00', collectMinutes: 0 },
    ];
    for (const settings of cases) {
      const mode = refreshModeOf(settings);
      const next = nextRunAt(settings, now);
      expect(next === null, JSON.stringify(settings)).toBe(mode === 'off');
      if (mode === 'daily') expect(next?.getHours()).toBe(18);
      if (mode === 'interval') expect(next?.getTime()).toBe(now.getTime() + settings.collectMinutes * 60_000);
    }
  });
});

describe('startScheduler', () => {
  it('间隔模式会真的触发 run()，stop() 之后不再触发且 nextAt 为 null', async () => {
    let runs = 0;
    const scheduler = startScheduler({
      // 0.002 分钟 = 120ms
      settings: { dailyRefreshEnabled: false, dailyRefreshAt: '08:00', collectMinutes: 0.002 },
      run: () => {
        runs += 1;
      },
    });

    try {
      await waitFor(() => runs > 0);
      expect(runs).toBeGreaterThan(0);
      expect(scheduler.nextAt()).not.toBeNull();
    } finally {
      scheduler.stop();
    }

    const afterStop = runs;
    expect(scheduler.nextAt()).toBeNull();
    await idle(200);
    expect(runs).toBe(afterStop);
  });

  it('每日模式下 nextAt 就是下一个 HH:mm，stop() 清干净', () => {
    const now = new Date();
    const target = new Date(now.getTime() + 90 * 60_000);
    const hhmm = `${String(target.getHours()).padStart(2, '0')}:${String(target.getMinutes()).padStart(2, '0')}`;

    const scheduler = startScheduler({
      settings: { dailyRefreshEnabled: true, dailyRefreshAt: hhmm, collectMinutes: 0 },
      run: () => {},
    });

    try {
      const next = scheduler.nextAt();
      expect(next).not.toBeNull();
      expect(next?.getHours()).toBe(target.getHours());
      expect(next?.getMinutes()).toBe(target.getMinutes());
    } finally {
      scheduler.stop();
    }
    expect(scheduler.nextAt()).toBeNull();
  });

  it('run 抛错不会让调度停摆（错误交给 onError）', async () => {
    const errors: unknown[] = [];
    let runs = 0;
    const scheduler = startScheduler({
      settings: { dailyRefreshEnabled: false, dailyRefreshAt: '08:00', collectMinutes: 0.002 },
      run: () => {
        runs += 1;
        throw new Error('采集炸了');
      },
      onError: (error) => errors.push(error),
    });

    try {
      await waitFor(() => runs >= 2);
      // 仍然在排下一次
      expect(scheduler.nextAt()).not.toBeNull();
    } finally {
      scheduler.stop();
    }
    expect(runs).toBeGreaterThanOrEqual(2);
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  it('reschedule 立即按新设置重排；改为不自动采集后 nextAt 变 null', () => {
    const scheduler = startScheduler({
      settings: { dailyRefreshEnabled: false, dailyRefreshAt: '08:00', collectMinutes: 600 },
      run: () => {},
    });

    try {
      expect(scheduler.nextAt()).not.toBeNull();

      scheduler.reschedule({ dailyRefreshEnabled: true, dailyRefreshAt: '05:00', collectMinutes: 600 });
      expect(scheduler.nextAt()?.getHours()).toBe(5);

      scheduler.reschedule({ dailyRefreshEnabled: false, dailyRefreshAt: '05:00', collectMinutes: 0 });
      expect(scheduler.nextAt()).toBeNull();
    } finally {
      scheduler.stop();
    }
  });

  it('已 stop 的调度器不会被 reschedule 复活（stop 是终态）', async () => {
    let runs = 0;
    const scheduler = startScheduler({
      settings: { dailyRefreshEnabled: false, dailyRefreshAt: '08:00', collectMinutes: 600 },
      run: () => {
        runs += 1;
      },
    });
    scheduler.stop();
    scheduler.reschedule({ dailyRefreshEnabled: false, dailyRefreshAt: '08:00', collectMinutes: 0.002 });

    expect(scheduler.nextAt()).toBeNull();
    await idle(150);
    expect(runs).toBe(0);
  });

  it('定时器 unref：不会成为进程退出的阻塞原因', () => {
    // getActiveResourcesInfo 只列「会让事件循环存活」的资源，unref 过的 Timeout 不在其中
    const timeouts = (): number =>
      process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length;

    const before = timeouts();
    const scheduler = startScheduler({
      settings: { dailyRefreshEnabled: false, dailyRefreshAt: '08:00', collectMinutes: 60 },
      run: () => {},
    });
    try {
      expect(timeouts()).toBe(before);
    } finally {
      scheduler.stop();
    }
  });
});
