/**
 * 运行时设置的持久化（key/value 表）。
 *
 * 为什么要单独一张表而不是扩充 config.ts：config 是进程启动时的环境快照，
 * 而「每天几点刷新」「KPI 高分线」「LLM key」必须能在设置页里改完立刻生效、
 * 重启还在，所以需要可写存储 + 一层「config 默认值 ← DB 覆盖」的合并规则。
 *
 * 为什么自带 `CREATE TABLE IF NOT EXISTS` 而不进 db.ts 的 MIGRATIONS：那张迁移表
 * 由存储层独占，settings 结构简单（三列、无外键），不值得为一个表改版本号。
 */
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { AppConfig } from '../config.js';
import { refreshModeOf } from '../scheduler.js';
import type { AppSettings, AppSettingsPatch } from '../types.js';

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`;

/** 嵌套字段拍平成点号 key，读的时候再拼回对象——表结构就一个 key/value，不为嵌套加列 */
const FLAT_KEYS = [
  'dailyRefreshAt',
  'dailyRefreshEnabled',
  'collectMinutes',
  'limitPerSource',
  'minKeepScore',
  'ttlDays',
  'highScore',
  'midScore',
  'llm.baseUrl',
  'llm.model',
  'llm.apiKey',
  'novelty.command',
] as const;

type FlatKey = (typeof FLAT_KEYS)[number];

/**
 * 只属于设置页、config.ts 里没有的默认值。
 * highScore/midScore 必须与现有 KPI 卡片口径一致（高分 ≥70 / 待判 50–70），
 * 否则用户第一次打开设置页会以为系统把阈值改了。
 */
export const SETTINGS_DEFAULTS = {
  dailyRefreshAt: '08:00',
  dailyRefreshEnabled: false,
  highScore: 70,
  midScore: 50,
} as const;

/**
 * 命令是否真的可用：设置页要回答的是「这个路径能不能用」，而不是「字符串非空」——
 * 用户把路径写错时这两种判定会给出完全相反的结论。
 * 纯命令名（不含 `/`）按 PATH 逐个查；任何情况都不抛错。
 */
export function commandAvailable(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed === '') return false;
  if (trimmed.includes('/')) return existsSync(trimmed);
  const dirs = (process.env.PATH ?? '').split(delimiter).filter((dir) => dir !== '');
  // 只看无扩展名的名字：这个 CLI 是本项目的 bash 脚本，不涉及 Windows PATHEXT
  return dirs.some((dir) => existsSync(join(dir, trimmed)));
}

const ensureTable = (db: DatabaseSync): void => {
  db.exec(CREATE_TABLE);
};

const flatten = (patch: AppSettingsPatch): Partial<Record<FlatKey, unknown>> => ({
  dailyRefreshAt: patch.dailyRefreshAt,
  dailyRefreshEnabled: patch.dailyRefreshEnabled,
  collectMinutes: patch.collectMinutes,
  limitPerSource: patch.limitPerSource,
  minKeepScore: patch.minKeepScore,
  ttlDays: patch.ttlDays,
  highScore: patch.highScore,
  midScore: patch.midScore,
  'llm.baseUrl': patch.llm?.baseUrl,
  'llm.model': patch.llm?.model,
  'llm.apiKey': patch.llm?.apiKey,
  'novelty.command': patch.novelty?.command,
});

/** 读回已保存的覆盖项；从未保存过时返回 `{}`（= 全用 config 默认值） */
export function readSettings(db: DatabaseSync): Partial<AppSettingsPatch> {
  ensureTable(db);
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const flat = new Map<string, unknown>();
  for (const row of rows) {
    try {
      flat.set(row.key, JSON.parse(row.value) as unknown);
    } catch {
      // 单行损坏不该让整站设置读不出来：忽略这条，回落默认值
    }
  }

  const pick = <T>(key: FlatKey): T | undefined => flat.get(key) as T | undefined;
  const patch: Partial<AppSettingsPatch> = {};

  const dailyRefreshAt = pick<string>('dailyRefreshAt');
  if (dailyRefreshAt !== undefined) patch.dailyRefreshAt = dailyRefreshAt;
  const dailyRefreshEnabled = pick<boolean>('dailyRefreshEnabled');
  if (dailyRefreshEnabled !== undefined) patch.dailyRefreshEnabled = dailyRefreshEnabled;
  const collectMinutes = pick<number>('collectMinutes');
  if (collectMinutes !== undefined) patch.collectMinutes = collectMinutes;
  const limitPerSource = pick<number>('limitPerSource');
  if (limitPerSource !== undefined) patch.limitPerSource = limitPerSource;
  const minKeepScore = pick<number>('minKeepScore');
  if (minKeepScore !== undefined) patch.minKeepScore = minKeepScore;
  const ttlDays = pick<number>('ttlDays');
  if (ttlDays !== undefined) patch.ttlDays = ttlDays;
  const highScore = pick<number>('highScore');
  if (highScore !== undefined) patch.highScore = highScore;
  const midScore = pick<number>('midScore');
  if (midScore !== undefined) patch.midScore = midScore;

  const llmBaseUrl = pick<string>('llm.baseUrl');
  const llmModel = pick<string>('llm.model');
  const llmApiKey = pick<string>('llm.apiKey');
  if (llmBaseUrl !== undefined || llmModel !== undefined || llmApiKey !== undefined) {
    patch.llm = {};
    if (llmBaseUrl !== undefined) patch.llm.baseUrl = llmBaseUrl;
    if (llmModel !== undefined) patch.llm.model = llmModel;
    if (llmApiKey !== undefined) patch.llm.apiKey = llmApiKey;
  }

  const command = pick<string>('novelty.command');
  if (command !== undefined) patch.novelty = { command };

  return patch;
}

/**
 * 合并写入（只写传了的字段，不会把没传的字段清空）。
 *
 * `llm.apiKey` 传空串表示「不改」：前端设置页永远拿不到明文 key，
 * 用户没重填时提交的就是空串，若照写就会把已有 key 抹掉。
 */
export function writeSettings(db: DatabaseSync, patch: AppSettingsPatch): Partial<AppSettingsPatch> {
  ensureTable(db);
  const flat = flatten(patch);
  const now = new Date().toISOString();
  const upsert = db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );

  db.exec('BEGIN');
  try {
    for (const key of FLAT_KEYS) {
      const value = flat[key];
      if (value === undefined || value === null) continue;
      if (key === 'llm.apiKey' && String(value) === '') continue;
      upsert.run(key, JSON.stringify(value), now);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return readSettings(db);
}

/** 最近一次保存时间；从未保存为 null（设置页用来显示「默认值 / 已修改」） */
export function settingsUpdatedAt(db: DatabaseSync): string | null {
  ensureTable(db);
  const row = db.prepare('SELECT MAX(updated_at) AS at FROM settings').get() as { at?: string | null } | undefined;
  return row?.at ?? null;
}

/**
 * 生效设置（给 UI 的视图）：config 默认值 ← DB 覆盖，**不含明文 apiKey**。
 * `nextRefreshAt` 由调度规则决定，路由层填，这里留 null。
 */
export function resolveSettings(
  config: AppConfig,
  patch: Partial<AppSettingsPatch>,
  updatedAt: string | null = null,
): AppSettings {
  const apiKey = patch.llm?.apiKey ?? config.llm.apiKey;
  const command = patch.novelty?.command ?? config.novelty.command;
  const dailyRefreshAt = patch.dailyRefreshAt ?? SETTINGS_DEFAULTS.dailyRefreshAt;
  const dailyRefreshEnabled = patch.dailyRefreshEnabled ?? SETTINGS_DEFAULTS.dailyRefreshEnabled;
  const collectMinutes = patch.collectMinutes ?? config.collectMinutes;
  return {
    dailyRefreshAt,
    dailyRefreshEnabled,
    collectMinutes,
    limitPerSource: patch.limitPerSource ?? config.limitPerSource,
    minKeepScore: patch.minKeepScore ?? config.minKeepScore,
    ttlDays: patch.ttlDays ?? config.ttlDays,
    highScore: patch.highScore ?? SETTINGS_DEFAULTS.highScore,
    midScore: patch.midScore ?? SETTINGS_DEFAULTS.midScore,
    llm: {
      baseUrl: patch.llm?.baseUrl ?? config.llm.baseUrl,
      model: patch.llm?.model ?? config.llm.model,
      hasApiKey: apiKey.trim() !== '',
    },
    novelty: { command, hasCommand: commandAvailable(command) },
    updatedAt,
    nextRefreshAt: null,
    // 与 nextRunAt 共用 refreshModeOf：界面说的模式就是调度器真正在跑的模式
    refreshMode: refreshModeOf({ dailyRefreshEnabled, dailyRefreshAt, collectMinutes }),
  };
}

/**
 * 生效配置（给运行时的视图）：设置页改完立刻作用于采集/生成，不必重启。
 * 与 resolveSettings 同源同一个 patch，只是这里保留明文 key —— 它只在进程内存里流转。
 */
export function applySettingsToConfig(config: AppConfig, patch: Partial<AppSettingsPatch>): AppConfig {
  return {
    ...config,
    collectMinutes: patch.collectMinutes ?? config.collectMinutes,
    limitPerSource: patch.limitPerSource ?? config.limitPerSource,
    minKeepScore: patch.minKeepScore ?? config.minKeepScore,
    ttlDays: patch.ttlDays ?? config.ttlDays,
    llm: {
      ...config.llm,
      baseUrl: patch.llm?.baseUrl ?? config.llm.baseUrl,
      model: patch.llm?.model ?? config.llm.model,
      apiKey: patch.llm?.apiKey ?? config.llm.apiKey,
    },
    novelty: {
      ...config.novelty,
      command: patch.novelty?.command ?? config.novelty.command,
    },
  };
}
