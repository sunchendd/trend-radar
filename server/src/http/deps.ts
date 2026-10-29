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
 * ../sources/probe.js  probeSource(input): Promise<{ sampleCount: number }>   ▲ 假定：未落地前的降级见 createSource
 * ==================================================================================
 */
import type { AppConfig } from '../config.js';
import type { VerdictSummary } from '../ideas/verdict.js';
import type {
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
} from '../types.js';
import { mapDomainError, notFound, serviceUnavailable, unprocessable } from './errors.js';

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
  stats(): Stats;
  runCollect(config: AppConfig, opts?: { sourceIds?: string[] }): Promise<RunRecord>;
  generateIdeas(req: GenerateIdeasRequest): Promise<GenerateIdeasResult>;

  /** LLM 是否可用：判定规则只认 ideas/llm.ts，HTTP 层不再复制一份 */
  isLlmConfigured(): boolean;

  /**
   * 查新判读的**唯一出口**：前端不该自己复制一份阈值逻辑。
   * 可选是因为 verdict.ts 缺失时要能降级成「不带摘要」，而不是整个接口 500。
   */
  summarizeVerdict?(records: NoveltyRecord[]): VerdictSummary;

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

  const openDb = pick<(dataDir: string) => Db>(dbModule, 'openDb', '../store/db.js');
  // 全进程只开一个连接：openDb 每调一次都是新连接，绝不能在请求里调
  const db = openDb(config.dataDir);

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
        records = await runNovelty(config, { queries: idea.queries, title: idea.title }, queries);
      } catch (cause) {
        // CLI 不可用 = 配置问题（503）；其它异常按真实故障冒泡成 500，别伪装成「未配置」
        throw mapDomainError(cause) ?? cause;
      }
      let current = idea;
      for (const record of records) current = q.addNoveltyRecord(db, id, record) ?? current;
      return rejudge(current);
    },

    listRuns: (limit) => q.listRuns(db, limit),
    stats: () => q.stats(db),
    runCollect: (cfg, opts) => runCollect(cfg, opts),
    generateIdeas: async (req) => {
      if (!generateIdeas) {
        throw serviceUnavailable('pipeline_unavailable', '选题流水线未就绪（ideas/pipeline.ts 需导出 generateIdeas）');
      }
      // 指定 itemIds 就按它取（保持请求顺序），否则用相关度 Top-N
      const items = req.itemIds?.length
        ? q.getItemsByIds(db, req.itemIds)
        : q.listItems(db, { sort: 'score', limit: maxInputItems, offset: 0 }).items;
      try {
        const result = await generateIdeas(config, req, items, {
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
        ? () => (llmModule.isLlmConfigured as (config: AppConfig) => boolean)(config)
        : () => true,

    close: () => {
      try {
        (db as { close?: () => void }).close?.();
      } catch {
        // 关库失败不该阻止进程退出
      }
    },
  };
}
