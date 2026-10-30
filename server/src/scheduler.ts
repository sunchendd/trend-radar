/**
 * 采集调度：每日定点优先，否则回落「每 N 分钟」间隔。
 *
 * 两条硬约束决定了实现方式：
 *  1. 定时器必须 `unref()`——它是后台节拍，不该成为进程/测试退出的阻塞原因；
 *  2. `stop()` 要真的清干净，所以每次重排都只保留**一个** setTimeout（不用 setInterval），
 *     并留一个 `stopped` 闸门挡住「正在跑的 run() 结束后又把定时器装回去」。
 *
 * 时间按服务器本地时区算（用户就是在自己机器上用），跨 DST 也由 Date 的本地语义兜住。
 */
import type { AppConfig } from './config.js';
import type { AppSettings } from './types.js';

/** 调度只关心这三个字段，传整个 AppSettings 也成立 */
export type SchedulerSettings = Pick<AppSettings, 'dailyRefreshEnabled' | 'dailyRefreshAt' | 'collectMinutes'>;

/** 与 AppSettings.refreshMode 同源，避免两处各写一份联合类型 */
export type RefreshMode = AppSettings['refreshMode'];

/** setTimeout 的上限（2^31-1 ms ≈ 24.8 天），超了浏览器/Node 会立刻触发 */
const MAX_DELAY_MS = 2 ** 31 - 1;

/** HH:mm 解析：`24:00`/`12:60`/空串等一律 null（时刻的合法性与「现在几点」无关） */
function parseHHmm(hhmm: string): { hours: number; minutes: number } | null {
  const matched = /^(\d{1,2}):(\d{2})$/u.exec(String(hhmm ?? '').trim());
  if (matched === null) return null;
  const hours = Number(matched[1]);
  const minutes = Number(matched[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  // 24:00 不是「今天结束」而是非法时刻：宁可返回 null 让上层回落，也不猜用户意图
  if (hours > 23 || minutes > 59) return null;
  return { hours, minutes };
}

/**
 * 下一次「每天 HH:mm」的时刻。
 * 当日该时刻已过（或正好是现在）就取次日；`24:00` 与任何非法写法返回 null。
 */
export function nextDailyRunAt(now: Date, hhmm: string): Date | null {
  const parsed = parseHHmm(hhmm);
  if (parsed === null) return null;

  const at = new Date(now.getTime());
  at.setHours(parsed.hours, parsed.minutes, 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at;
}

/**
 * 当前生效的调度模式。`refreshMode` 字段与 `nextRunAt` 共用这一个判定，
 * 否则「界面说每日、实际按间隔跑」这种分叉迟早会出现。
 */
export function refreshModeOf(settings: SchedulerSettings): RefreshMode {
  if (settings.dailyRefreshEnabled && parseHHmm(settings.dailyRefreshAt) !== null) return 'daily';
  const minutes = Number(settings.collectMinutes);
  if (Number.isFinite(minutes) && minutes > 0) return 'interval';
  return 'off';
}

/**
 * 按优先级算下一次采集时刻：每日定时 > 间隔采集 > 不采。
 * 每日定时开着但时间非法时回落到间隔采集，而不是静默停止——用户的意图是「自动采」。
 */
export function nextRunAt(settings: SchedulerSettings, now: Date): Date | null {
  switch (refreshModeOf(settings)) {
    case 'daily':
      return nextDailyRunAt(now, settings.dailyRefreshAt);
    case 'interval':
      return new Date(now.getTime() + Number(settings.collectMinutes) * 60_000);
    default:
      return null;
  }
}

export interface SchedulerOptions {
  /** 采集动作；抛错只会走 onError，不会让调度停摆 */
  run: () => Promise<unknown> | unknown;
  settings: SchedulerSettings;
  /** 兼容调用方传完整 AppConfig：settings 缺 collectMinutes 时用它兜底 */
  config?: AppConfig;
  now?: () => Date;
  onError?: (error: unknown) => void;
}

export interface Scheduler {
  stop(): void;
  /** 下一次触发的绝对时刻；未启用/已停止为 null */
  nextAt(): Date | null;
  /** 设置变更后立即重排（PUT /api/settings 会调） */
  reschedule(settings: SchedulerSettings): void;
}

export function startScheduler(options: SchedulerOptions): Scheduler {
  const clock = options.now ?? (() => new Date());
  let settings: SchedulerSettings = options.settings ?? {
    dailyRefreshEnabled: false,
    dailyRefreshAt: '',
    collectMinutes: options.config?.collectMinutes ?? 0,
  };
  let timer: NodeJS.Timeout | undefined;
  let next: Date | null = null;
  let stopped = false;

  const clearTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  /** 从 `from` 起算并装表；`from` 用「刚刚触发的那一刻」而不是 now，避免重复触发同一时刻 */
  const arm = (from: Date): void => {
    clearTimer();
    if (stopped) {
      next = null;
      return;
    }
    const at = nextRunAt(settings, from);
    next = at;
    if (at === null) return;
    const delay = Math.min(Math.max(0, at.getTime() - clock().getTime()), MAX_DELAY_MS);
    timer = setTimeout(fire, delay);
    timer.unref();
  };

  const fire = (): void => {
    timer = undefined;
    const firedAt = next ?? clock();
    // 先把下一次排好：run() 抛错或跑很久都不会让节拍断掉
    arm(new Date(Math.max(clock().getTime(), firedAt.getTime() + 1)));
    void Promise.resolve()
      .then(() => options.run())
      .catch((error: unknown) => options.onError?.(error));
  };

  arm(clock());

  return {
    stop(): void {
      stopped = true;
      clearTimer();
      next = null;
    },
    nextAt: () => next,
    reschedule(nextSettings: SchedulerSettings): void {
      settings = nextSettings;
      // 已停止的调度器不因设置变更复活：stop 是终态
      arm(clock());
    },
  };
}
