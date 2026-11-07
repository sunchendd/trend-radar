/**
 * HTTP 层与下层模块之间**唯一**的接缝。
 *
 * 下层模块由别人并行开发（存储层已落地，采集/选题流水线可能还在写），所以这里
 * 全部走「非字面量说明符」的 `await import(specifier)`：tsc 不解析路径（http/**
 * 自身保持零错误），运行时才加载，缺导出时给出可操作的报错，而不是
 * `undefined is not a function`。
 *
 * ==================== 已对齐的真实签名（依据 collector 的通知） ====================
 * ../store/db.js       openDb(dataDir: string): DatabaseSync        // ':memory:' 走内存库
 * ../store/queries.js  （db 一律第一参数）
 *   listItems(db, q: ItemQuery): Paged<Item>            // limit 夹到 1–200
 *   getItem(db, id), listSources(db)
 *   insertSource(db, { id, kind, label, url, weight?, tags?, note?, enabled? }): Source
 *   updateSource(db, id, { enabled?, weight?, note?, label?, url? }): Source | undefined
 *   deleteSource(db, id): boolean                       // 条目保留，sourceId 不变（孤儿靠 getSource 判）
 *   listIdeas(db, status?), getIdea(db, id), updateIdea(db, id, patch)
 *   addNoveltyRecord(db, id, rec: NoveltyRecord): Idea | undefined
 *   exportItems(db, q: ItemQuery, max = 5000): Item[]
 *   listRuns(db, limit = 20), stats(db, now?)
 * ../collect.js        runCollect(config, deps?: { sourceIds?: readonly string[] }): Promise<RunRecord>
 *                      单源失败进 errors；进程内已有 in-flight 去重（key=dataDir）
 * ../ideas/pipeline.js generateIdeas(config, req, items: Item[], options?: { existing?: {title}[] }): Promise<GenerateIdeasResult>
 *                      items 由 HTTP 层按 req.itemIds 或相关度 Top-N 取好再传进去
 *                      IdeaGenerationError.code: no_items|all_invalid|llm_bad_output|llm_output_truncated
 * ../ideas/novelty.js  runNovelty(config, idea: {queries, title?}, queries?, options?): Promise<NoveltyRecord[]>
 *                      NoveltyNotConfiguredError（带 code='novelty_not_configured'）
 * ../ideas/verdict.js  verdict(records): { verdict, reason, status } / statusOf(v): IdeaStatus
 *                      summarizeVerdict(records): { verdict, headline, evidence[], suggestions[] }  // 给 UI 的徽标摘要
 * ../ideas/llm.js      isLlmConfigured(config): boolean
 *                      createLlm(config): LlmClient     // chat 用；未配置抛 LlmNotConfiguredError
 * ../sources/probe.js  probeSource(input): Promise<{ sampleCount: number }>   ▲ 假定：未落地前的降级见 createSource
 * ==================================================================================
 */
import type { AppConfig } from '../config.js';
import {
  applySettingsToConfig,
  readSettings,
  resolveSettings,
  settingsUpdatedAt,
  writeSettings,
} from '../store/settings.js';
import type { VerdictSummary } from '../ideas/verdict.js';
import type { LlmClient } from '../ideas/llm.js';
import type { Watch, WatchEngine } from '../store/watches.js';
import type { FetchLike } from '../push/bark.js';
import type { IdeaCluster } from '../ideas/cluster.js';
import type { SweepOptions, SweepResult } from '../sweep.js';
import type {
  AppSettings,
  AppSettingsPatch,
  ExtractionRunResult,
  ExtractionStatus,
  GenerateIdeasRequest,
  Idea,
  IdeaStatus,
  Item,
  ItemQuery,
  NoveltyRecord,
  Paged,
  RunRecord,
  Source,
  Stats,
  TranslationRunResult,
  TranslationStatus,
} from '../types.js';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import * as watches from '../store/watches.js';
import * as paperStore from '../store/papers.js';
import { createPaperService, PaperError, type PaperFileRef } from '../papers/service.js';
import { clusterIdeas } from '../ideas/cluster.js';
import { ApiException, mapDomainError, notFound, serviceUnavailable, unprocessable } from './errors.js';

export interface NewSourceInput {
  id: string;
  kind: Source['kind'];
  label: string;
  url: string;
  weight?: number;
  tags?: string[];
  note?: string;
}

export interface SourcePatch {
  enabled?: boolean;
  weight?: number;
  note?: string;
}

export interface IdeaPatch {
  status?: IdeaStatus;
  title?: string;
  problem?: string;
  solution?: string;
  effect?: string;
  queries?: string[];
  risks?: string[];
}

export interface IdeaDraftDrop {
  index: number;
  title: string;
  reasons: string[];
}

/** pipeline 的返回是超集：`dropped`/`meta` 一并透传给前端（用户才知道「要 3 条为什么只回来 2 条」） */
/** 与 ideas/llm.ts 的 IdeaLlm 结构一致；测试注入用，生产走 config.llm */
export type IdeaLlmLike = { complete: (messages: unknown[], options?: unknown) => Promise<string> };

export interface LoadDepsOptions {
  /** 注入 LLM（测试用）：让真实 pipeline + 真实 store 在不出网的情况下跑完整链路 */
  llm?: IdeaLlmLike;
}

export interface GenerateIdeasResult {
  ideas: Idea[];
  usedItems: string[];
  dropped?: IdeaDraftDrop[];
  meta?: { promptVersion: string; model: string; focus: string; requested: number };
}

/** 路由层看到的全部下层能力；测试里直接注入内存实现 */
export interface HttpDeps {
  listItems(query: ItemQuery): Paged<Item>;
  getItem(id: string): Item | undefined;
  exportItems(query: ItemQuery, max?: number): Item[];

  listSources(): Source[];
  createSource(input: NewSourceInput): Promise<Source>;
  updateSource(id: string, patch: SourcePatch): Source | undefined;
  deleteSource(id: string): boolean;

  listIdeas(status?: IdeaStatus): Idea[];
  getIdea(id: string): Idea | undefined;
  updateIdea(id: string, patch: IdeaPatch): Idea | undefined;
  archiveIdea(id: string): Idea | undefined;
  /** 手工创建工作台里的选题（LLM 未配置或想自己写一条时用）；返回落库后的对象 */
  saveIdea(idea: Idea): Idea;
  recordNovelty(id: string, record: NoveltyRecord): Idea | undefined;
  autoNovelty(id: string, queries: string[] | undefined): Promise<Idea>;

  listRuns(limit?: number): RunRecord[];

  /** 论文阅读器：PDF 下载状态 / 触发下载 / 文件引用 / 高亮笔记标注 */
  getPaperStatus(id: string): paperStore.PaperInfo;
  downloadPaper(id: string): Promise<paperStore.PaperInfo>;
  getPaperFile(id: string): PaperFileRef | undefined;
  listPaperAnnotations(itemId: string): paperStore.PaperAnnotation[];
  addPaperAnnotation(itemId: string, input: paperStore.AnnotationInput): paperStore.PaperAnnotation;
  updatePaperAnnotation(
    itemId: string,
    annotationId: string,
    patch: { note?: string; color?: string },
  ): paperStore.PaperAnnotation | undefined;
  removePaperAnnotation(itemId: string, annotationId: string): boolean;

  /** 选题按技术方向聚类（同一方向的多条选题要能被看出来） */
  clusterIdeas(status?: IdeaStatus): IdeaCluster<Idea>[];

  /** 检索式巡检：盯住的方向 + 命中数快照 */
  listWatches(includeDisabled?: boolean): Watch[];
  addWatch(input: { query: string; note?: string; engine?: WatchEngine }): Watch;
  removeWatch(id: string): boolean;
  setWatchEnabled(id: string, enabled: boolean): boolean;
  /** 跑一轮巡检（会调用外部查新 CLI，可能几十秒） */
  sweepWatches(options?: SweepOptions): Promise<SweepResult>;
  stats(): Stats;
  runCollect(config: AppConfig, opts?: { sourceIds?: string[] }): Promise<RunRecord>;
  generateIdeas(req: GenerateIdeasRequest): Promise<GenerateIdeasResult>;

  /** 自动翻译：状态快照（设置页/状态端点用） */
  translationStatus(): TranslationStatus;
  /** 手动触发一轮翻译（「翻译今日」按钮）；llm 未配置时返回 degraded 不抛错 */
  runTranslation(): Promise<TranslationRunResult>;
  /** 工程动态：release 抽取状态（页面 KPI + 懒触发判断） */
  extractionStatus(): ExtractionStatus;
  /** 手动/懒触发一轮抽取（LLM 未配置走规则兜底） */
  runExtraction(): Promise<ExtractionRunResult>;

  /** LLM 是否可用：判定规则只认 ideas/llm.ts，HTTP 层不再复制一份 */
  isLlmConfigured(): boolean;

  /**
   * chat 对话用的 LLM 客户端工厂：必须以 settings 覆盖后的**生效配置**构建
   * （路由层拿到的 config 只是 env 基线，不含 DB 覆盖）。未配置时抛
   * LlmNotConfiguredError（映射 503）。可选：llm.ts 缺失时 chat 降级为 503。
   */
  createLlmClient?(): LlmClient;

  /**
   * 生效设置（config 默认值 ← settings 表覆盖）。**不含明文 apiKey**，只给 hasApiKey。
   * `nextRefreshAt` 由路由按调度规则填，这里给 null。
   */
  getSettings(): AppSettings;
  /** 合并写入并返回最新生效设置；`llm.apiKey` 传空串 = 不改 */
  updateSettings(patch: AppSettingsPatch): AppSettings;

  /**
   * 查新判读的**唯一出口**：前端不该自己复制一份阈值逻辑。
   * 可选是因为 verdict.ts 缺失时要能降级成「不带摘要」，而不是整个接口 500。
   */
  summarizeVerdict?(records: NoveltyRecord[]): VerdictSummary;

  /**
   * 外部 HTTP 注入（Bark 测试推送等出网调用）；缺省用全局 fetch。
   * 测试注入假实现，保证「设置页测试推送」这类端点离线可测。
   */
  fetchLike?: FetchLike;

  /** 释放 sqlite 句柄；由 app 的 onClose 调用一次 */
  close(): void;
}

type AnyModule = Record<string, unknown>;
type Db = unknown;

const loadOptionalModule = async (specifier: string): Promise<AnyModule | undefined> => {
  try {
    return (await import(/* @vite-ignore */ specifier)) as AnyModule;
  } catch {
    return undefined;
  }
};

const loadModule = async (specifier: string): Promise<AnyModule> => {
  const module = await loadOptionalModule(specifier);
  if (!module) throw new Error(`[http/deps] 加载 ${specifier} 失败：模块还没就绪（签名见 deps.ts 顶部注释）`);
  return module;
};

function pick<T>(mod: AnyModule, name: string, where: string): T {
  const value = mod[name];
  if (typeof value !== 'function') {
    throw new Error(`[http/deps] ${where} 缺少导出 ${name}()；签名见 deps.ts 顶部注释`);
  }
  return value as T;
}

/** 查新结论 → 选题状态，规则只认 verdict.ts 的 statusOf()，HTTP 层不自己发明 */
interface VerdictFns {
  verdict?: (records: NoveltyRecord[]) => { status?: IdeaStatus };
  statusOf?: (verdict: unknown) => IdeaStatus;
}

export async function loadDeps(config: AppConfig, options: LoadDepsOptions = {}): Promise<HttpDeps> {
  const dbModule = await loadModule('../store/db.js');
  const queries = await loadModule('../store/queries.js');
  const collectModule = await loadModule('../collect.js');
  const pipelineModule = await loadModule('../ideas/pipeline.js');
  // 下面这些都是可选模块：不在时退化为「契约里声明的默认行为」，而不是整个服务起不来
  const noveltyModule = await loadOptionalModule('../ideas/novelty.js');
  const verdictModule = await loadOptionalModule('../ideas/verdict.js');
  const llmModule = await loadOptionalModule('../ideas/llm.js');
  const probeModule = await loadOptionalModule('../sources/probe.js');
  const translationModule = await loadOptionalModule('../translation/translate.js');
  const extractionModule = await loadOptionalModule('../extraction/releases.js');

  const openDb = pick<(dataDir: string) => Db>(dbModule, 'openDb', '../store/db.js');
  // 全进程只开一个连接：openDb 每调一次都是新连接，绝不能在请求里调
  const db = openDb(config.dataDir);

  // 论文阅读器的 PDF 服务：文件落在 <dataDir>/papers/，与 sqlite 同生命周期
  const paperService = createPaperService(db as DatabaseSync, {
    papersDir: join(config.dataDir, 'papers'),
  });

  const q = {
    listItems: pick<(db: Db, query: ItemQuery) => Paged<Item>>(queries, 'listItems', '../store/queries.js'),
    getItem: pick<(db: Db, id: string) => Item | undefined>(queries, 'getItem', '../store/queries.js'),
    exportItems: pick<(db: Db, query: ItemQuery, max?: number) => Item[]>(
      queries,
      'exportItems',
      '../store/queries.js',
    ),
    listSources: pick<(db: Db) => Source[]>(queries, 'listSources', '../store/queries.js'),
    insertSource: pick<(db: Db, input: NewSourceInput) => Source>(queries, 'insertSource', '../store/queries.js'),
    updateSource: pick<(db: Db, id: string, patch: SourcePatch) => Source | undefined>(
      queries,
      'updateSource',
      '../store/queries.js',
    ),
    deleteSource: pick<(db: Db, id: string) => boolean>(queries, 'deleteSource', '../store/queries.js'),
    getItemsByIds: pick<(db: Db, ids: string[]) => Item[]>(queries, 'getItemsByIds', '../store/queries.js'),
    upsertIdea: pick<(db: Db, idea: Idea) => Idea>(queries, 'upsertIdea', '../store/queries.js'),
    listIdeas: pick<(db: Db, status?: IdeaStatus) => Idea[]>(queries, 'listIdeas', '../store/queries.js'),
    getIdea: pick<(db: Db, id: string) => Idea | undefined>(queries, 'getIdea', '../store/queries.js'),
    updateIdea: pick<(db: Db, id: string, patch: IdeaPatch) => Idea | undefined>(
      queries,
      'updateIdea',
      '../store/queries.js',
    ),
    addNoveltyRecord: pick<(db: Db, id: string, record: NoveltyRecord) => Idea | undefined>(
      queries,
      'addNoveltyRecord',
      '../store/queries.js',
    ),
    listRuns: pick<(db: Db, limit?: number) => RunRecord[]>(queries, 'listRuns', '../store/queries.js'),
    stats: pick<(db: Db) => Stats>(queries, 'stats', '../store/queries.js'),
    listTranslationCandidates: pick<(db: Db, limit: number) => { id: string; kind: string; title: string; summary: string; zhKey: string | null }[]>(
      queries,
      'listTranslationCandidates',
      '../store/queries.js',
    ),
    translationCountToday: pick<(db: Db, now?: Date) => number>(queries, 'translationCountToday', '../store/queries.js'),
    listExtractionCandidates: pick<(db: Db, limit: number) => { id: string; title: string; summary: string; pointsKey: string | null }[]>(
      queries,
      'listExtractionCandidates',
      '../store/queries.js',
    ),
    extractionCountToday: pick<(db: Db, now?: Date) => number>(queries, 'extractionCountToday', '../store/queries.js'),
    releaseKpi: pick<(db: Db, now?: Date) => { todayReleases: number; pointsTotal: number; extractedTotal: number }>(
      queries,
      'releaseKpi',
      '../store/queries.js',
    ),
  };

  // 第二个实参照传：collect.ts 现在是 runCollect(config)，多余实参在 JS 里无害；
  // 等它支持源过滤时这里自动生效，不用再改 HTTP 层
  const runCollect = pick<(config: AppConfig, opts?: { sourceIds?: string[] }) => Promise<RunRecord>>(
    collectModule,
    'runCollect',
    '../collect.js',
  );
  const generateIdeas = pipelineModule
    ? pick<
        (
          config: AppConfig,
          req: GenerateIdeasRequest,
          items: Item[],
          options?: { existing?: { title: string }[]; llm?: IdeaLlmLike },
        ) => Promise<GenerateIdeasResult>
      >(pipelineModule, 'generateIdeas', '../ideas/pipeline.js')
    : undefined;
  // 喂给模型的最大条目数由 pipeline 定，HTTP 层只负责按它的口径取数据
  const maxInputItems =
    typeof pipelineModule?.MAX_INPUT_ITEMS === 'number' ? (pipelineModule.MAX_INPUT_ITEMS as number) : 12;

  const runNovelty = noveltyModule
    ? pick<
        (
          config: AppConfig,
          idea: { queries: string[]; title?: string },
          queries?: string[],
        ) => Promise<NoveltyRecord[]>
      >(noveltyModule, 'runNovelty', '../ideas/novelty.js')
    : undefined;

  /** 翻译模块（t18）：缺失时翻译端点降级为 503，而不是整个服务起不来 */
  const runTranslationPass = translationModule
    ? pick<
        (
          config: AppConfig,
          deps: { db: Db; llm?: unknown; now?: Date; batchSize?: number; dailyLimit?: number; scanLimit?: number },
          options?: { background?: boolean },
        ) => Promise<TranslationRunResult>
      >(translationModule, 'runTranslationPass', '../translation/translate.js')
    : undefined;
  const runnerState = translationModule
    ? pick<(dataDir: string) => { inflight: boolean; lastRunAt: string | null; lastError: string | null }>(
        translationModule,
        'translationRunnerState',
        '../translation/translate.js',
      )
    : undefined;
  const needsTranslationFn = translationModule
    ? pick<(item: { kind: string; title: string; summary: string; zhKey?: string | null }) => boolean>(
        translationModule,
        'needsTranslation',
        '../translation/translate.js',
      )
    : undefined;

  /** 抽取模块（t21）：缺失时抽取端点降级为 503 */
  const runExtractionPass = extractionModule
    ? pick<
        (
          config: AppConfig,
          deps: { db: Db; llm?: unknown; now?: Date; batchSize?: number; dailyLimit?: number; scanLimit?: number },
          options?: { background?: boolean },
        ) => Promise<ExtractionRunResult>
      >(extractionModule, 'runExtractionPass', '../extraction/releases.js')
    : undefined;
  const extractionRunnerStateFn = extractionModule
    ? pick<(dataDir: string) => { inflight: boolean; lastRunAt: string | null; lastError: string | null }>(
        extractionModule,
        'extractionRunnerState',
        '../extraction/releases.js',
      )
    : undefined;
  const needsExtractionFn = extractionModule
    ? pick<(item: { summary: string; pointsKey?: string | null }) => boolean>(
        extractionModule,
        'needsExtraction',
        '../extraction/releases.js',
      )
    : undefined;

  /** 手动/采集后的抽取入口共用：LLM 客户端按生效配置现造 */
  const buildExtractLlm = async (): Promise<unknown | undefined> => {
    if (!llmModule || typeof llmModule.createLlm !== 'function') return undefined;
    const createLlm = llmModule.createLlm as (config: AppConfig) => unknown;
    try {
      return createLlm(effectiveConfig());
    } catch {
      return undefined;
    }
  };

  const pendingExtractionCount = (limit = 400): number => {
    if (!needsExtractionFn) return 0;
    let count = 0;
    for (const candidate of q.listExtractionCandidates(db as Db, limit)) {
      if (needsExtractionFn(candidate)) count += 1;
    }
    return count;
  };

  /** 手动/采集后的翻译入口共用：LLM 客户端按生效配置现造（key 可能在设置页刚改过） */
  const buildTranslateLlm = async (): Promise<unknown | undefined> => {
    if (!llmModule || typeof llmModule.createLlm !== 'function') return undefined;
    const createLlm = llmModule.createLlm as (config: AppConfig) => unknown;
    try {
      return createLlm(effectiveConfig());
    } catch {
      // LlmNotConfiguredError → undefined：runTranslationPass 走 degraded 分支
      return undefined;
    }
  };

  const pendingTranslationCount = (limit = 600): number => {
    if (!needsTranslationFn) return 0;
    let count = 0;
    for (const candidate of q.listTranslationCandidates(db as Db, limit)) {
      if (needsTranslationFn(candidate)) count += 1;
    }
    return count;
  };
  const verdictFns: VerdictFns = verdictModule
    ? {
        verdict:
          typeof verdictModule.verdict === 'function'
            ? (verdictModule.verdict as VerdictFns['verdict'])
            : undefined,
        statusOf:
          typeof verdictModule.statusOf === 'function'
            ? (verdictModule.statusOf as VerdictFns['statusOf'])
            : undefined,
      }
    : {};

  /**
   * 运行时生效配置：每次调用都读一次 settings 表，所以设置页改完立刻作用于
   * 采集/生成，不必重启进程。读几行 key/value 的开销可以忽略。
   */
  const effectiveConfig = (): AppConfig => applySettingsToConfig(config, readSettings(db as DatabaseSync));
  const snapshotSettings = (): AppSettings =>
    resolveSettings(config, readSettings(db as DatabaseSync), settingsUpdatedAt(db as DatabaseSync));

  /** 写入查新记录后按 verdict.ts 重算状态；archived 是人工结论，不被自动翻案 */
  const rejudge = (idea: Idea): Idea => {
    if (idea.status === 'archived') return idea;
    if (!verdictFns.verdict || !verdictFns.statusOf) return idea;
    const outcome = verdictFns.verdict(idea.novelty);
    const next = outcome.status ?? verdictFns.statusOf(outcome);
    if (!next || next === idea.status) return idea;
    return q.updateIdea(db, idea.id, { status: next }) ?? idea;
  };

  return {
    listItems: (query) => q.listItems(db, query),
    getItem: (id) => q.getItem(db, id),
    exportItems: (query, max) => q.exportItems(db, query, max),

    listSources: () => q.listSources(db),
    createSource: async (input) => {
      if (!probeModule || typeof probeModule.probeSource !== 'function') {
        // 契约要求「先探活再落库」。探活模块缺失时宁可失败，也不要把没验证过的源写进库
        throw serviceUnavailable('probe_unavailable', '源探活模块未就绪（sources/probe.ts 需导出 probeSource）');
      }
      try {
        await (probeModule.probeSource as (input: NewSourceInput) => Promise<unknown>)(input);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        throw unprocessable('source_probe_failed', `源探活失败：${message}`, { sourceId: input.id });
      }
      return q.insertSource(db, input);
    },
    updateSource: (id, patch) => q.updateSource(db, id, patch),
    deleteSource: (id) => q.deleteSource(db, id),

    listIdeas: (status) => q.listIdeas(db, status),
    getIdea: (id) => q.getIdea(db, id),
    updateIdea: (id, patch) => q.updateIdea(db, id, patch),
    archiveIdea: (id) => q.updateIdea(db, id, { status: 'archived' }),
    saveIdea: (idea) => q.upsertIdea(db, idea),
    recordNovelty: (id, record) => {
      const updated = q.addNoveltyRecord(db, id, record);
      return updated ? rejudge(updated) : undefined;
    },
    autoNovelty: async (id, queries) => {
      const idea = q.getIdea(db, id);
      if (!idea) throw notFound(`选题 ${id} 不存在`);
      if (!runNovelty) {
        throw serviceUnavailable('novelty_not_configured', '查新模块未就绪（ideas/novelty.ts 需导出 runNovelty）');
      }
      let records: NoveltyRecord[];
      try {
        records = await runNovelty(effectiveConfig(), { queries: idea.queries, title: idea.title }, queries);
      } catch (cause) {
        // CLI 不可用 = 配置问题（503）；其它异常按真实故障冒泡成 500，别伪装成「未配置」
        throw mapDomainError(cause) ?? cause;
      }
      let current = idea;
      for (const record of records) current = q.addNoveltyRecord(db, id, record) ?? current;
      return rejudge(current);
    },

    listRuns: (limit) => q.listRuns(db, limit),

    // ---- 论文阅读器：PDF 下载与标注（服务在 loadDeps 期创建一次，连接复用全局 db） ----
    getPaperStatus: (id) => paperService.status(id),
    downloadPaper: async (id) => {
      const item = q.getItem(db, id);
      if (!item) throw notFound(`条目 ${id} 不存在`);
      try {
        return await paperService.download(id, item);
      } catch (cause) {
        if (cause instanceof PaperError) {
          const mapped =
            cause.code === 'invalid_item_id'
              ? new ApiException(400, cause.code, cause.message)
              : cause.code === 'paper_no_pdf'
                ? unprocessable(cause.code, cause.message)
                : serviceUnavailable(cause.code, cause.message);
          throw mapped;
        }
        throw cause;
      }
    },
    getPaperFile: (id) => paperService.file(id),
    listPaperAnnotations: (itemId) => paperStore.listAnnotations(db as DatabaseSync, itemId),
    addPaperAnnotation: (itemId, input) => {
      if (!q.getItem(db, itemId)) throw notFound(`条目 ${itemId} 不存在`);
      return paperStore.addAnnotation(db as DatabaseSync, itemId, input);
    },
    updatePaperAnnotation: (itemId, annotationId, patch) =>
      paperStore.updateAnnotation(db as DatabaseSync, itemId, annotationId, patch),
    removePaperAnnotation: (itemId, annotationId) =>
      paperStore.removeAnnotation(db as DatabaseSync, itemId, annotationId),

    clusterIdeas: (status) => clusterIdeas(q.listIdeas(db, status)),
    listWatches: (includeDisabled) => watches.listWatches(db as DatabaseSync, includeDisabled ?? false),
    addWatch: (input) => watches.addWatch(db as DatabaseSync, input),
    removeWatch: (id) => watches.removeWatch(db as DatabaseSync, id),
    setWatchEnabled: (id, enabled) => {
      const updated = watches.setWatchEnabled(db as DatabaseSync, id, enabled);
      return updated !== undefined;
    },
    sweepWatches: async (options) => {
      const sweep = (await import('../sweep.js')).sweepWatches;
      return sweep(effectiveConfig(), db as DatabaseSync, options ?? {});
    },
    stats: () => q.stats(db),
    // 传入的 cfg 只是兜底：真正生效的配置以 settings 覆盖后的为准
    runCollect: (_cfg, opts) =>
      runCollect(effectiveConfig(), opts).then((run) => {
        // 采集落库后异步后处理：①t18 翻译 ②t21 release 技术点抽取。
        // 都不阻塞采集响应；失败只进各自 runner 状态快照。
        if (snapshotSettings().translation.enabled) {
          void (async () => {
            try {
              if (!runTranslationPass) return;
              const llm = await buildTranslateLlm();
              await runTranslationPass(effectiveConfig(), { db, llm }, { background: true });
            } catch {
              // 后台任务的兜底：状态已记录在 runnerState.lastError
            }
            try {
              if (!runExtractionPass) return;
              const llm = await buildExtractLlm();
              await runExtractionPass(effectiveConfig(), { db, llm }, { background: true });
            } catch {
              // 同上：extractionRunnerState.lastError
            }
          })();
        }
        return run;
      }),
    generateIdeas: async (req) => {
      if (!generateIdeas) {
        throw serviceUnavailable('pipeline_unavailable', '选题流水线未就绪（ideas/pipeline.ts 需导出 generateIdeas）');
      }
      // 指定 itemIds 就按它取（保持请求顺序），否则用相关度 Top-N
      const items = req.itemIds?.length
        ? q.getItemsByIds(db, req.itemIds)
        : q.listItems(db, { sort: 'score', limit: maxInputItems, offset: 0 }).items;
      try {
        const result = await generateIdeas(effectiveConfig(), req, items, {
          existing: q.listIdeas(db),
          ...(options.llm ? { llm: options.llm } : {}),
        });
        // pipeline 不碰 sqlite（分工使然），落库必须在接缝处做：
        // 否则新选题不会出现在 GET /api/ideas，下次的 existing 去重也永远是空的
        return { ...result, ideas: result.ideas.map((idea) => q.upsertIdea(db, idea)) };
      } catch (cause) {
        // 领域错误按统一规则翻译；认不出来的照原样冒泡，交给 500 兜底
        throw mapDomainError(cause) ?? cause;
      }
    },
    // llm.ts 不在时不要假装「未配置」，否则会把配置齐全的环境误判成 503；
    // 权威判定在 pipeline 里（抛 code=llm_not_configured）
    ...(verdictModule && typeof verdictModule.summarizeVerdict === 'function'
      ? { summarizeVerdict: (records: NoveltyRecord[]) => (verdictModule.summarizeVerdict as (r: NoveltyRecord[]) => VerdictSummary)(records) }
      : {}),
    isLlmConfigured:
      llmModule && typeof llmModule.isLlmConfigured === 'function'
        ? () => (llmModule.isLlmConfigured as (config: AppConfig) => boolean)(effectiveConfig())
        : () => true,
    // chat 的客户端工厂：每次对话现建一个（无状态），配置永远取 settings 覆盖后的生效值
    ...(llmModule && typeof llmModule.createLlm === 'function'
      ? { createLlmClient: (): LlmClient => (llmModule.createLlm as (config: AppConfig) => LlmClient)(effectiveConfig()) }
      : {}),

    translationStatus: (): TranslationStatus => {
      const settings = snapshotSettings();
      const state = runnerState ? runnerState(config.dataDir) : { inflight: false, lastRunAt: null, lastError: null };
      return {
        enabled: settings.translation.enabled,
        llmConfigured: llmModule
          ? (llmModule.isLlmConfigured as (config: AppConfig) => boolean)(effectiveConfig())
          : false,
        dailyLimit: settings.translation.dailyLimit,
        translatedToday: q.translationCountToday(db as Db),
        pending: pendingTranslationCount(),
        inflight: state.inflight,
        lastRunAt: state.lastRunAt,
        lastError: state.lastError,
      };
    },
    runTranslation: async (): Promise<TranslationRunResult> => {
      if (!runTranslationPass) {
        throw serviceUnavailable('translation_unavailable', '翻译模块未就绪（translation/translate.ts 需导出 runTranslationPass）');
      }
      const settings = snapshotSettings();
      if (!settings.translation.enabled) {
        throw unprocessable('translation_disabled', '自动翻译已在设置页关闭；打开后才能手动触发');
      }
      const llm = await buildTranslateLlm();
      return runTranslationPass(effectiveConfig(), { db, llm });
    },

    extractionStatus: (): ExtractionStatus => {
      const settings = snapshotSettings();
      const state = extractionRunnerStateFn
        ? extractionRunnerStateFn(config.dataDir)
        : { inflight: false, lastRunAt: null, lastError: null };
      const kpi = q.releaseKpi(db as Db);
      return {
        enabled: settings.translation.enabled,
        llmConfigured: llmModule
          ? (llmModule.isLlmConfigured as (config: AppConfig) => boolean)(effectiveConfig())
          : false,
        dailyLimit: settings.translation.dailyLimit,
        usedToday: q.translationCountToday(db as Db) + q.extractionCountToday(db as Db),
        pending: pendingExtractionCount(),
        extractedTotal: kpi.extractedTotal,
        pointsTotal: kpi.pointsTotal,
        todayReleases: kpi.todayReleases,
        inflight: state.inflight,
        lastRunAt: state.lastRunAt,
        lastError: state.lastError,
      };
    },
    runExtraction: async (): Promise<ExtractionRunResult> => {
      if (!runExtractionPass) {
        throw serviceUnavailable('extraction_unavailable', '抽取模块未就绪（extraction/releases.ts 需导出 runExtractionPass）');
      }
      const settings = snapshotSettings();
      if (!settings.translation.enabled) {
        throw unprocessable('extraction_disabled', '自动处理已在设置页关闭；打开后才能手动触发');
      }
      const llm = await buildExtractLlm();
      return runExtractionPass(effectiveConfig(), { db, llm });
    },

    getSettings: snapshotSettings,
    updateSettings: (patch) => {
      writeSettings(db as DatabaseSync, patch);
      return snapshotSettings();
    },

    close: () => {
      try {
        (db as { close?: () => void }).close?.();
      } catch {
        // 关库失败不该阻止进程退出
      }
    },
  };
}
