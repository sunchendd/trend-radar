import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface AppConfig {
  /** 数据目录（sqlite + 导出），默认 ./data */
  dataDir: string;
  port: number;
  host: string;
  /** 定时采集间隔（分钟），0 = 只手动 */
  collectMinutes: number;
  /** 相关度阈值以下不入库（省磁盘），默认 0 全留 */
  minKeepScore: number;
  /** 单源抓取上限 */
  limitPerSource: number;
  /** 新闻类 RSS（tags 带 news）单源上限；取 min(limitPerSource, 本值) */
  limitPerNewsSource: number;
  /** 条目保留天数 */
  ttlDays: number;
  llm: {
    /** OpenAI 兼容端点；留空则 ideas 生成走 mock，可在 UI 里手工填选题 */
    baseUrl: string;
    apiKey: string;
    model: string;
    temperature: number;
    maxTokens: number;
    /** 翻译/抽取批次是否带 thinking:{type:"disabled"}（默认开，t24） */
    thinkingDisabled: boolean;
  };
  /** 智慧芽查新：走外部 CLI（zhihuiya-patent-search skill），不配则手工录入 */
  novelty: {
    command: string;
    agreeKick: boolean;
  };
  /** 自动中文翻译（论文/新闻标题+摘要；LLM 复用 llm 配置） */
  translation: {
    enabled: boolean;
    dailyLimit: number;
  };
  /** Bark 每日推送（env 首次默认；settings 表可覆盖 url/enabled） */
  bark: {
    url: string;
    enabled: boolean;
  };
}

const num = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    dataDir: resolve(env.TREND_RADAR_DATA_DIR ?? env.DATA_DIR ?? join(process.cwd(), 'data')),
    port: num(env.PORT, 8787),
    host: env.HOST ?? '127.0.0.1',
    collectMinutes: num(env.COLLECT_MINUTES, 360),
    minKeepScore: num(env.MIN_KEEP_SCORE, 0),
    limitPerSource: num(env.LIMIT_PER_SOURCE, 40),
    /** 新闻类 RSS 单源上限（tags 带 news 的源）。41 个新闻源若都吃满 limitPerSource，
     *  一轮会灌上千条背景条目稀释新闻页；默认 20 条足够覆盖当天新闻（多数源日更 <20 条）。 */
    limitPerNewsSource: num(env.LIMIT_PER_NEWS_SOURCE, 20),
    ttlDays: num(env.TTL_DAYS, 180),
    llm: {
      baseUrl: env.LLM_BASE_URL ?? env.OPENAI_BASE_URL ?? '',
      apiKey: env.LLM_API_KEY ?? env.OPENAI_API_KEY ?? '',
      // 默认 GLM-5.3-Flash（用户 coding plan 订阅）；示例端点见 README「LLM 配置」
      model: env.LLM_MODEL ?? 'glm-5.3-flash',
      temperature: num(env.LLM_TEMPERATURE, 0.7),
      maxTokens: num(env.LLM_MAX_TOKENS, 8000),
      /** 翻译/抽取等机械任务默认关思考（省 ~90% token；智谱端点支持该参数） */
      thinkingDisabled: env.TREND_LLM_THINKING_DISABLED !== '0',
    },
    novelty: {
      command: env.ZHY_COMMAND ?? join(homedir(), '.agents/skills/zhihuiya-patent-search/scripts/batch_search.sh'),
      agreeKick: env.ZHY_AGREE_KICK === '1',
    },
    translation: {
      // 设置页可改（settings 表覆盖）；env 只提供首次默认值
      enabled: env.TREND_TRANSLATION_DISABLED !== '1',
      // 全量翻译口径：41+ RSS 源日增数百条，500 不够用（t24 复核为 2000）
      dailyLimit: num(env.TREND_TRANSLATION_DAILY_LIMIT, 2000),
    },
    bark: {
      // 形如 https://api.day.app/<key>；留空 = 推送链路整体静默
      url: env.BARK_URL ?? '',
      // 默认启用（配了 URL 就是想收）；TREND_BARK_DISABLED=1 可整体关掉
      enabled: env.TREND_BARK_DISABLED !== '1',
    },
  };
}
