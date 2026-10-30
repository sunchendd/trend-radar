/**
 * 手写 SVG 图形：相关度环 / 7 日 sparkline / 相关度直方图 / 查新命中分布条。
 * 不引图表库——这些形状本来就比库的默认样式更该被手工控制。
 */
import { useId, type JSX } from 'react';
import type { NoveltyRecord, Stats } from '../lib/types';
import {
  BAND_META,
  LOG_TICKS,
  TONE_COLOR,
  bandOf,
  bucketLower,
  fmtInt,
  logPos,
  scoreTone,
} from '../lib/format';

// ------------------------------------------------------------------ 相关度环

export function ScoreRing({
  score,
  size = 44,
  stroke = 3.5,
  caption,
}: {
  score: number;
  size?: number;
  stroke?: number;
  caption?: string;
}): JSX.Element {
  const rawId = useId();
  const gid = `ring-${rawId.replace(/[:]/g, '')}`;
  const r = (size - stroke) / 2 - 1;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, score)) / 100;
  const tone = scoreTone(score);
  const color = TONE_COLOR[tone];

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={`相关度 ${Math.round(score)} 分`}
      className="shrink-0"
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.55" />
          <stop offset="100%" stopColor={color} />
        </linearGradient>
      </defs>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-track)" strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={`url(#${gid})`}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${c * pct} ${c}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: 'stroke-dasharray .5s cubic-bezier(.22,.68,.32,1)' }}
      />
      <text
        x="50%"
        y="50%"
        dominantBaseline="central"
        textAnchor="middle"
        fill="var(--color-ink)"
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: size * 0.34,
          fontWeight: 600,
          fontVariantNumeric: 'tabular-nums',
          letterSpacing: '-0.02em',
        }}
      >
        {Math.round(score)}
      </text>
      {caption ? (
        <text
          x="50%"
          y="66%"
          dominantBaseline="central"
          textAnchor="middle"
          fill="var(--color-ink-3)"
          style={{ fontSize: size * 0.16, letterSpacing: '0.04em' }}
        >
          {caption}
        </text>
      ) : null}
    </svg>
  );
}

// ------------------------------------------------------------------ 7 日 sparkline

export function Sparkbars({
  data,
  width = 92,
  height = 26,
  gap = 2.5,
}: {
  data: { date: string; count: number }[];
  width?: number;
  height?: number;
  gap?: number;
}): JSX.Element {
  const n = Math.max(1, data.length);
  const max = Math.max(1, ...data.map((d) => d.count));
  const bw = (width - gap * (n - 1)) / n;
  const empty = data.every((d) => d.count === 0);

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" className="shrink-0 overflow-visible">
      {/* 全是 0 时画一条基线：用「轨道色画数据柱」会读成一个灰色方块，等于把"没数据"画成了"有数据" */}
      {empty ? (
        <line x1={0} y1={height - 1} x2={width} y2={height - 1} stroke="var(--color-track-2)" strokeWidth={1} />
      ) : null}
      {data.map((d, i) => {
        const h = Math.max(2, (d.count / max) * (height - 2));
        const last = i === n - 1;
        return (
          <g key={`${d.date}-${i}`}>
            <rect
              x={i * (bw + gap)}
              y={height - h}
              width={bw}
              height={h}
              rx={Math.min(2, bw / 2)}
              // 历史柱也用强调色（只是更淡）：track 色是"空槽道"，拿它画数据会让人以为没数据
              fill="var(--color-accent)"
              opacity={last ? 0.95 : 0.32}
            >
              <title>{`${d.date} · ${d.count} 条`}</title>
            </rect>
          </g>
        );
      })}
    </svg>
  );
}

// ------------------------------------------------------------------ 相关度直方图

export function ScoreHistogram({
  bins,
  minScore,
  height = 44,
}: {
  bins: Stats['scoreHistogram'];
  minScore: number;
  height?: number;
}): JSX.Element {
  const max = Math.max(1, ...bins.map((b) => b.count));
  return (
    <div>
      <div className="flex items-end gap-1" style={{ height }}>
        {bins.map((b, i) => {
          const lo = bucketLower(b.bucket);
          const active = lo !== null && lo + 20 > minScore;
          const h = Math.max(2, (b.count / max) * height);
          return (
            <div key={`${b.bucket}-${i}`} className="group relative flex flex-1 items-end">
              <div
                className="w-full rounded-[2px] transition-all duration-200"
                style={{
                  height: h,
                  background: active
                    ? 'linear-gradient(to top, color-mix(in oklab, var(--color-accent) 45%, var(--color-surface)), color-mix(in oklab, var(--color-accent) 88%, var(--color-surface)))'
                    : 'var(--color-track)',
                }}
                title={`${b.bucket} · ${b.count} 条`}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex justify-between text-[9.5px] text-ink-3">
        <span className="num">0</span>
        <span className="num">50</span>
        <span className="num">100</span>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ 查新分布条

/**
 * 极简横向分布条：0–100 对数刻度。
 * 左边是 0 命中（交叉带空位），右边是红海；一眼能看出空位在哪。
 */
export function NoveltyBar({ records }: { records: NoveltyRecord[] }): JSX.Element {
  const known = records.filter((r) => r.hits !== null);
  const unknown = records.filter((r) => r.hits === null);
  const TICK_TOP = 13;
  const pct = (v: number): number => logPos(v) * 100;

  return (
    <div className="select-none">
      <div className="relative" style={{ height: 36 }}>
        {/* 稀疏交叉带（1–5 命中）：机会窗口 */}
        <div
          className="absolute"
          style={{
            left: `${pct(1)}%`,
            width: `${pct(5) - pct(1)}%`,
            top: TICK_TOP - 6,
            height: 14,
            borderRadius: 3,
            background: 'color-mix(in oklab, var(--color-accent) 7%, transparent)',
            border: '1px dashed color-mix(in oklab, var(--color-accent) 28%, transparent)',
          }}
          title="稀疏交叉带：1–5 命中，最值得读权利要求"
        />
        {/* 红海区（≥50 命中） */}
        <div
          className="absolute"
          style={{
            left: `${pct(50)}%`,
            right: 0,
            top: TICK_TOP - 6,
            height: 14,
            borderRadius: 3,
            background: 'color-mix(in oklab, var(--color-danger) 7%, transparent)',
            border: '1px dashed color-mix(in oklab, var(--color-danger) 26%, transparent)',
          }}
          title="红海区：≥50 命中，已成建制布防"
        />
        {/* 轨道 */}
        <div
          className="absolute right-0 left-0"
          style={{ top: TICK_TOP, height: 2, borderRadius: 2, background: 'var(--color-track-2)' }}
        />
        {/* 刻度 */}
        {LOG_TICKS.map((t) => (
          <span
            key={`tick-${t}`}
            className="absolute"
            style={{
              left: `${pct(t)}%`,
              top: TICK_TOP - 5,
              width: 1,
              height: 12,
              background: t === 50 ? 'color-mix(in oklab, var(--color-danger) 55%, transparent)' : 'var(--color-line-strong)',
            }}
          />
        ))}
        {/* 命中标记 */}
        {known.map((r, i) => {
          const hits = r.hits ?? 0;
          const meta = BAND_META[bandOf(r.hits)];
          return (
            <span
              key={`m-${r.at}-${i}`}
              className="absolute"
              title={`${r.query} · ${hits} 命中（${meta.label}）`}
              style={{
                left: `${pct(hits)}%`,
                top: TICK_TOP - 2.5,
                width: 7,
                height: 7,
                marginLeft: -3.5,
                borderRadius: 99,
                background: meta.color,
                boxShadow: `0 0 0 2.5px color-mix(in oklab, ${meta.color} 16%, transparent)`,
              }}
            />
          );
        })}
        {/* 刻度文案 */}
        {[0, 5, 50, 100].map((t) => (
          <span
            key={`label-${t}`}
            className="num absolute text-[9px] whitespace-nowrap text-ink-3"
            style={{
              left: `${pct(t)}%`,
              top: TICK_TOP + 9,
              transform: t === 100 ? 'translateX(-100%)' : t === 0 ? 'translateX(0)' : 'translateX(-50%)',
            }}
          >
            {t === 0 ? '0（无效）' : t === 50 ? '50（红海线）' : t === 100 ? '100+' : String(t)}
          </span>
        ))}
      </div>
      {unknown.length > 0 ? (
        <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-warn">
          <span className="inline-block h-[6px] w-[6px] rounded-full bg-warn" />
          {unknown.length} 条解析失败（命中数未知，不落在刻度上，需重跑）
        </div>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ 迷你对比条（查新列表里用）

export function HitsMeter({ hits }: { hits: number }): JSX.Element {
  const pos = logPos(hits) * 100;
  const meta = BAND_META[bandOf(hits)];
  return (
    <div className="relative h-[3px] w-full overflow-hidden rounded-full bg-track">
      <div
        className="absolute top-0 bottom-0 left-0 rounded-full"
        style={{
          width: `${Math.max(3, pos)}%`,
          background: `linear-gradient(to right, color-mix(in oklab, ${meta.color} 40%, transparent), ${meta.color})`,
        }}
      />
    </div>
  );
}

/** 命中数的文本呈现：null 与 0 必须视觉可区分 */
export function HitsValue({ hits }: { hits: number | null }): JSX.Element {
  if (hits === null) {
    return (
      <span className="inline-flex items-baseline gap-1">
        <span className="num text-[13px] text-warn">—</span>
        <span className="text-[10.5px] text-warn/85">命中数未知</span>
      </span>
    );
  }
  if (hits === 0) {
    // 0 命中不是"空位"：先怀疑检索式（AND 语义，词多即空）
    return (
      <span className="inline-flex items-baseline gap-1">
        <span className="num text-[13px] font-semibold text-ink-2">0</span>
        <span className="text-[10.5px] text-ink-3">零命中 · 需改词</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className="num text-[13px] font-semibold text-ink">{fmtInt(hits)}</span>
      <span className="text-[10.5px] text-ink-3">命中</span>
    </span>
  );
}
