/**
 * trend-radar 领域模型（**冻结契约**）
 *
 * 这个文件是 server 内部各模块与 web 前端共用的唯一事实来源。
 * 改动它 = 改契约：必须同步更新 docs/api.md，并通知所有人。
 */

// ---------------------------------------------------------------- 情报源

export type SourceKind =
  /** arXiv API / 分类列表，走 export.arxiv.org */
  | 'arxiv'
  /** Atom feed（GitHub Releases 等） */
  | 'atom'
  /** 普通 RSS 2.0 / RSSHub */
  | 'rss';

export interface Source {
  /** 稳定 slug，用作主键，例如 `arxiv-speculative-decoding` */
  id: string;
  kind: SourceKind;
  /** 展示名 */
  label: string;
  /**
   * 抓取地址。arxiv 源也是完整 API URL（**不要**用 category 拼地址，
   * 关键词订阅必须走 URL，否则分类一改就抓错）。 */
  url: string;
  /** 该源在本领域的分量，0.1–3，参与相关度打分 */
  weight: number;
  enabled: boolean;
  /** 自由标签，前端用于分组，例如 ['paper', 'engine'] */
  tags: string[];
  /** 为什么加这个源（人工备注，便于新人接手） */
  note: string;
  createdAt: string;
}

// ---------------------------------------------------------------- 条目

export type ItemKind = 'paper' | 'news' | 'release';

export interface Item {
  /** sha1(sourceId + 归一化 url) 前 16 位，去重键 */
  id: string;
  sourceId: string;
  kind: ItemKind;
  title: string;
  url: string;
  summary: string;
  authors: string[];
  /** ISO 时间；缺失时退化为抓取时间 */
  publishedAt: string;
  fetchedAt: string;
  /** 打分结果 0–100，见 server/src/score.ts */
  score: number;
  /** 打分理由，前端展示「为什么这条值得看」 */
  scoreReasons: ScoreReason[];
  /** 抽到的关键词（小写） */
  keywords: string[];
  /** arXiv/DOI 等外部主键，用于跨源去重 */
  externalId?: string;
}

export interface ScoreReason {
  rule: string;
  delta: number;
  detail: string;
}

// ---------------------------------------------------------------- 采集运行

export interface SourceError {
  sourceId: string;
  message: string;
}

export interface RunRecord {
  id: string;
  startedAt: string;
  finishedAt: string;
  /** 参与抓取的源数量（仅 enabled） */
  sourceCount: number;
  /** 本次新增条目数（去重后） */
  added: number;
  /** 抓到的原始条目数 */
  fetched: number;
  errors: SourceError[];
  /**
   * 每个源的耗时与产出（v2 新增）。用来回答"哪个源最慢/最不产出"——
   * 没有它，采集慢 22 秒时用户只能猜是 arXiv 还是某个 RSS。
   */
  perSource?: RunPerSource[];
}

export interface RunPerSource {
  sourceId: string;
  /** 毫秒；失败时也有值（超时/连接失败同样耗时间） */
  ms: number;
  items: number;
  error?: string;
}

// ---------------------------------------------------------------- 专利选题

export type IdeaStatus = 'draft' | 'verified' | 'red-ocean' | 'archived';

export interface NoveltyRecord {
  at: string;
  /** 检索式原文 */
  query: string;
  /** 命中数；null = 页面解析失败，0 = 真的没有 */
  hits: number | null;
  /** 头部申请人，形如「华为技术有限公司:7、中国电信:3」 */
  topAssignees: string;
  note: string;
  /** zhihuiya = 智慧芽，manual = 人工录入 */
  site: 'zhihuiya' | 'manual' | 'other';
}

export interface Idea {
  id: string;
  createdAt: string;
  updatedAt: string;
  title: string;
  /** 要解决的技术问题 */
  problem: string;
  /** 技术方案（多特征，专利撰写口径） */
  solution: string;
  /** 有益效果（量化口径） */
  effect: string;
  keywords: string[];
  /** IPC 分类号提示 */
  ipcHints: string[];
  /** 建议的查新检索式（3–5 个中文词，等词数便于对比） */
  queries: string[];
  /** 撞车风险点 */
  risks: string[];
  status: IdeaStatus;
  /** 生成这条选题时引用/依据的情报条目 */
  cites: string[];
  /** 生成用的 focus 快照，便于复现 */
  focus: string;
  /** 生成这条选题时的 prompt 版本号，出问题能定位到口径 */
  promptVersion?: string;
  novelty: NoveltyRecord[];
}

/** 判读徽标摘要：由 ideas/verdict.ts 的 summarizeVerdict() 生成，前端只展示不重算 */
export interface VerdictSummary {
  verdict: NoveltyVerdict;
  /** 直接当徽标文案的一行短句，≤24 字 */
  headline: string;
  evidence: { query: string; hits: number | null; topAssignees: string }[];
  /** inconclusive 时给可执行的改词建议 */
  suggestions: string[];
}

/** GET /api/ideas 的响应元素：Idea 的附加视图，不改变 Idea 契约 */
export type IdeaWithVerdict = Idea & { verdictSummary: VerdictSummary };

/** 查新判读：由命中数机械推出，不允许凭感觉写 */
export type NoveltyVerdict = 'red-ocean' | 'opportunity' | 'gap' | 'inconclusive';

// ---------------------------------------------------------------- API DTO

export interface Stats {
  items: number;
  ideas: number;
  sources: number;
  enabledSources: number;
  lastRunAt: string | null;
  /** 近 7 天每日新增条目数，前端画柱状图 */
  dailyAdded: { date: string; count: number }[];
  /** 相关度分布直方图，桶 [0,20) [20,40) ... */
  scoreHistogram: { bucket: string; count: number }[];
}

export interface ItemQuery {
  q?: string;
  sourceId?: string;
  kind?: ItemKind;
  /** 多选类型：论文视图只传 ['paper']，新闻视图传 ['news','release'] */
  kinds?: ItemKind[];
  minScore?: number;
  since?: string;
  sort?: 'score' | 'time';
  limit?: number;
  offset?: number;
}

export interface Paged<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface GenerateIdeasRequest {
  focus: string;
  count: number;
  /** 不传则用相关度最高的 N 条 */
  itemIds?: string[];
}

export interface ApiError {
  error: { code: string; message: string; detail?: unknown };
}


/**
 * 运行时设置（设置页可改，覆盖 env 默认值）。
 *
 * 落库在 settings 表（key/value JSON），启动时叠加到 config 上。
 * 安全约定：**API Key 永不回传明文**，只回传 `hasApiKey`；写入时才传 `apiKey`。
 */
export interface AppSettings {
  /** 每天定时刷新时刻 "HH:mm"（服务器本地时区） */
  dailyRefreshAt: string;
  /** 定时刷新开关；关闭时回落到 `collectMinutes` 间隔（0 = 不自动采集） */
  dailyRefreshEnabled: boolean;
  /** 间隔采集（分钟），仅在没有开启每日定时时有意义 */
  collectMinutes: number;
  /** 每次每源抓取上限 */
  limitPerSource: number;
  /** 低于该分数不入库 */
  minKeepScore: number;
  /** 条目保留天数 */
  ttlDays: number;
  /** KPI 高分线 */
  highScore: number;
  /** KPI 待判线 */
  midScore: number;
  llm: {
    baseUrl: string;
    model: string;
    /** 是否已配置 key（不回传明文） */
    hasApiKey: boolean;
  };
  novelty: {
    command: string;
    hasCommand: boolean;
  };
  /** 上次保存时间（ISO）；从未保存过为 null */
  updatedAt: string | null;
  /** 下一次定时刷新的时间（ISO）；未启用为 null */
  nextRefreshAt: string | null;
  /**
   * 当前靠什么在定时刷新：`daily` 每日定点 / `interval` 间隔采集 / `off` 不自动采集。
   * 前端要区分「明天 08:00 再来」和「每 360 分钟一次」，只看 nextRefreshAt 分不出来。
   */
  refreshMode: 'daily' | 'interval' | 'off';
}

/** PUT /api/settings 的入参：全部可选，只改传了的字段 */
export interface AppSettingsPatch {
  dailyRefreshAt?: string;
  dailyRefreshEnabled?: boolean;
  collectMinutes?: number;
  limitPerSource?: number;
  minKeepScore?: number;
  ttlDays?: number;
  highScore?: number;
  midScore?: number;
  llm?: { baseUrl?: string; model?: string; apiKey?: string };
  novelty?: { command?: string };
}
