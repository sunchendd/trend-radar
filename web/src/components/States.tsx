/**
 * 空态 / 错误态。
 * 错误态必须可操作：后端没起时直接给出要敲的命令，而不是白屏或「出了点问题」。
 */
import type { JSX, ReactNode } from 'react';
import { friendlyError, isDemo } from '../lib/api';
import { Icon, type IconName } from './Icon';
import { Spinner } from './primitives';

export function EmptyState({
  icon = 'search',
  title,
  hint,
  action,
}: {
  icon?: IconName;
  title: string;
  hint?: string;
  action?: ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center rounded-card border border-dashed border-line px-6 py-14 text-center">
      <div
        className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl border border-line"
        style={{ background: 'var(--color-surface)', color: 'var(--color-ink-3)' }}
      >
        <Icon name={icon} size={19} />
      </div>
      <div className="text-[13.5px] font-medium text-ink">{title}</div>
      {hint ? <p className="mt-1.5 max-w-[380px] text-[12px] leading-relaxed text-ink-3">{hint}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

/** 页内错误横幅（后端未启动时的重要落点） */
export function ErrorState({
  error,
  onRetry,
  retrying = false,
}: {
  error: unknown;
  onRetry?: () => void;
  retrying?: boolean;
}): JSX.Element {
  const f = friendlyError(error);
  return (
    <div className="card overflow-hidden">
      <div className="flex items-start gap-3 p-4">
        <div
          className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border"
          style={{
            color: 'var(--color-warn)',
            background: 'color-mix(in oklab, var(--color-warn) 9%, transparent)',
            borderColor: 'color-mix(in oklab, var(--color-warn) 30%, transparent)',
          }}
        >
          <Icon name={f.offline ? 'antenna' : 'alert'} size={17} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-medium text-ink">{f.title}</div>
          {f.hint ? <p className="mt-1 text-[12px] leading-relaxed text-ink-2">{f.hint}</p> : null}
          {f.offline ? (
            <div className="mt-2.5 inline-flex items-center gap-2 rounded-lg border border-line bg-sunken px-2.5 py-1.5">
              <span className="text-[10.5px] text-ink-3">命令</span>
              <code className="num text-[11.5px] text-accent">npm run dev:server</code>
            </div>
          ) : null}
          {isDemo() ? (
            <p className="mt-2.5 text-[11.5px] text-ink-3">
              当前显示的是<strong className="text-warn"> 演示数据 </strong>
              （仅开发模式兜底，不会写库）。后端起来后刷新即可切回真实数据。
            </p>
          ) : null}
        </div>
        {onRetry ? (
          <button type="button" className="btn shrink-0" onClick={onRetry} disabled={retrying}>
            {retrying ? <Spinner size={13} /> : <Icon name="refresh" size={13} />}
            重试
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** 采集结果等一次性反馈的紧凑提示条 */
export function NoticeBar({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'ok' | 'warn';
  children: ReactNode;
}): JSX.Element {
  const color =
    tone === 'ok' ? 'var(--color-accent)' : tone === 'warn' ? 'var(--color-warn)' : 'var(--color-info)';
  return (
    <div
      className="flex items-start gap-2 rounded-lg border px-2.5 py-2 text-[11.5px] leading-relaxed"
      style={{
        color: 'var(--color-ink-2)',
        background: `color-mix(in oklab, ${color} 7%, var(--color-surface))`,
        borderColor: `color-mix(in oklab, ${color} 26%, transparent)`,
      }}
    >
      <span className="mt-[1px] shrink-0" style={{ color }}>
        <Icon name="info" size={13} />
      </span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
