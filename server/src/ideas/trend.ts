/**
 * 检索式巡检的趋势判读（纯函数，无 IO）
 *
 * 为什么需要它：查新是"事后验证"——选题写完了才发现红海。真正有产品价值的是**事前信号**：
 * 某个方向的专利命中数环比突然涨了，说明有人在同一处布专利，这才是选题触发器。
 *
 * 判读只依赖命中数序列，不给"建议发明什么"——那是 LLM 的事，规则只负责如实报警。
 */
export type TrendLevel = 'surge' | 'warm' | 'flat' | 'cool' | 'new-front' | 'baseline';

export interface TrendInput {
  /** 按时间升序的命中数快照；null 表示那次页面解析失败（不能当成 0！） */
  history: (number | null)[];
}

export interface TrendOutcome {
  level: TrendLevel;
  /** 一句话结论，可直接当徽标/告警文案 */
  headline: string;
  /** 环比变化率（0.32 = +32%）；基线不足或除零时为 null */
  deltaPct: number | null;
  /** 最新一次与上一次的命中数（解析失败记为 null 而不是 0） */
  latest: number | null;
  previous: number | null;
  /** 是否值得据此出选题 */
  actionable: boolean;
}

const SURGE_PCT = 0.3;
const SURGE_MIN_HITS = 5;
const WARM_PCT = 0.15;
const COOL_PCT = -0.25;

const pct = (value: number): string => `${value >= 0 ? '+' : ''}${Math.round(value * 100)}%`;

/**
 * 只看最后两个有效快照（解析失败的记录跳过，不参与环比）。
 * 这样即使某天智慧芽页面改版导致解析失败，也不会把趋势判成"骤降 100%"。
 */
export function detectTrend(input: TrendInput): TrendOutcome {
  const valid = input.history.filter((hits): hits is number => hits !== null);
  const latest = valid.length > 0 ? (valid[valid.length - 1] as number) : null;

  if (valid.length === 0) {
    return {
      level: 'baseline',
      headline: '暂无有效命中数（解析失败或从未巡检）',
      deltaPct: null,
      latest: null,
      previous: null,
      actionable: false,
    };
  }
  if (valid.length === 1) {
    return {
      level: 'baseline',
      headline: `已建立基线：${latest} 命中，下次巡检才能算环比`,
      deltaPct: null,
      latest,
      previous: null,
      actionable: false,
    };
  }

  const previous = valid[valid.length - 2] as number;
  const latestHits = latest as number;
  const delta = latestHits - previous;

  // 从 0 到有：之前一条都没有，现在出现了 —— 这是"新方向冒头"，比涨幅更有信息量
  if (previous === 0) {
    if (latestHits > 0) {
      return {
        level: 'new-front',
        headline: `新方向冒头：从 0 涨到 ${latestHits} 命中`,
        deltaPct: null,
        latest: latestHits,
        previous,
        actionable: latestHits >= 3,
      };
    }
    return {
      level: 'flat',
      headline: '连续两次零命中：先怀疑检索式，再谈空白',
      deltaPct: 0,
      latest: 0,
      previous,
      actionable: false,
    };
  }

  const deltaPct = delta / previous;
  if (deltaPct >= SURGE_PCT && latestHits >= SURGE_MIN_HITS) {
    return {
      level: 'surge',
      headline: `升温 ${pct(deltaPct)}：${previous} → ${latestHits} 命中`,
      deltaPct,
      latest: latestHits,
      previous,
      actionable: true,
    };
  }
  if (deltaPct >= WARM_PCT) {
    return {
      level: 'warm',
      headline: `微升 ${pct(deltaPct)}：${previous} → ${latestHits} 命中`,
      deltaPct,
      latest: latestHits,
      previous,
      actionable: false,
    };
  }
  if (deltaPct <= COOL_PCT) {
    return {
      level: 'cool',
      headline: `降温 ${pct(deltaPct)}：${previous} → ${latestHits} 命中`,
      deltaPct,
      latest: latestHits,
      previous,
      actionable: false,
    };
  }
  return {
    level: 'flat',
    headline: `平稳 ${pct(deltaPct)}：${previous} → ${latestHits} 命中`,
    deltaPct,
    latest: latestHits,
    previous,
    actionable: false,
  };
}

/** 阈值做成常量导出，UI 文案与测试共用同一份口径，避免两处漂移 */
export const TREND_THRESHOLDS = { SURGE_PCT, SURGE_MIN_HITS, WARM_PCT, COOL_PCT } as const;
