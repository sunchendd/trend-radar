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
  /** 条目保留天数 */
  ttlDays: number;
  llm: {
    /** OpenAI 兼容端点；留空则 ideas 生成走 mock，可在 UI 里手工填选题 */
    baseUrl: string;
    apiKey: string;
    model: string;
    temperature: number;
    maxTokens: number;
  };
  /** 智慧芽查新：走外部 CLI（zhihuiya-patent-search skill），不配则手工录入 */
  novelty: {
    command: string;
    agreeKick: boolean;
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
    ttlDays: num(env.TTL_DAYS, 180),
    llm: {
      baseUrl: env.LLM_BASE_URL ?? env.OPENAI_BASE_URL ?? '',
      apiKey: env.LLM_API_KEY ?? env.OPENAI_API_KEY ?? '',
      model: env.LLM_MODEL ?? 'deepseek-chat',
      temperature: num(env.LLM_TEMPERATURE, 0.7),
      maxTokens: num(env.LLM_MAX_TOKENS, 8000),
    },
    novelty: {
      command: env.ZHY_COMMAND ?? join(homedir(), '.agents/skills/zhihuiya-patent-search/scripts/batch_search.sh'),
      agreeKick: env.ZHY_AGREE_KICK === '1',
    },
  };
}
