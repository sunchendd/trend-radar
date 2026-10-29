/**
 * 基础视觉原语：徽标 / 状态点 / 开关 / 滑杆 / 分段控件 / Spinner。
 * 全部只用 token 里的颜色，避免散落魔法值。
 */
import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import type { IdeaStatus } from '../lib/types';
import { STATUS_META } from '../lib/format';

// ------------------------------------------------------------------ 文本

export function Eyebrow({ children, className = '' }: { children: ReactNode; className?: string }): JSX.Element {
  return <div className={`eyebrow ${className}`}>{children}</div>;
}

// ------------------------------------------------------------------ 徽标

export interface PillProps {
  children: ReactNode;
  color?: string;
  bg?: string;
  border?: string;
  mono?: boolean;
  title?: string;
  className?: string;
  icon?: IconName;
}

export function Pill({
  children,
  color = 'var(--color-ink-2)',
  bg = 'rgb(255 255 255 / 0.04)',
  border = 'var(--color-line)',
  mono = false,
  title,
  className = '',
  icon,
}: PillProps): JSX.Element {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-[2px] text-[10.5px] leading-[15px] whitespace-nowrap ${
        mono ? 'num' : ''
      } ${className}`}
      style={{ color, background: bg, borderColor: border }}
    >
      {icon ? <Icon name={icon} size={11} /> : null}
      {children}
    </span>
  );
}

/** 选题状态点 + 文案 */
export function StatusBadge({ status, size = 'md' }: { status: IdeaStatus; size?: 'sm' | 'md' }): JSX.Element {
  const meta = STATUS_META[status];
  const dot = size === 'sm' ? 6 : 7;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap" title={meta.desc}>
      <span
        className="inline-block rounded-full"
        style={{
          width: dot,
          height: dot,
          background: meta.color,
          boxShadow: `0 0 0 3px color-mix(in oklab, ${meta.color} 14%, transparent)`,
        }}
      />
      <span className={size === 'sm' ? 'text-[11px]' : 'text-xs'} style={{ color: meta.color }}>
        {meta.label}
      </span>
    </span>
  );
}

// ------------------------------------------------------------------ 开关

export interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
}

export function Toggle({ checked, onChange, disabled = false, label }: ToggleProps): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-[19px] w-[34px] shrink-0 rounded-full border transition-colors duration-150 ${
        disabled ? 'cursor-not-allowed opacity-45' : 'cursor-pointer'
      }`}
      style={{
        background: checked ? 'color-mix(in oklab, var(--color-accent) 24%, #0b1416)' : '#131c1f',
        borderColor: checked ? 'color-mix(in oklab, var(--color-accent) 55%, transparent)' : 'var(--color-line-strong)',
      }}
    >
      <span
        className="absolute top-1/2 h-[13px] w-[13px] -translate-y-1/2 rounded-full transition-all duration-150"
        style={{
          left: checked ? 17 : 2,
          background: checked ? 'var(--color-accent)' : '#5b6d74',
          boxShadow: checked ? '0 0 8px -1px rgb(53 231 197 / 0.8)' : 'none',
        }}
      />
    </button>
  );
}

// ------------------------------------------------------------------ 滑杆

export interface SliderProps {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  onCommit?: (v: number) => void;
  label: string;
  format?: (v: number) => string;
  /** 拖完多久算「提交」（触发一次网络请求），避免每移动 1px 打一次接口 */
  commitDelayMs?: number;
}

export function Slider({
  value,
  min,
  max,
  step,
  onChange,
  onCommit,
  label,
  format,
  commitDelayMs = 450,
}: SliderProps): JSX.Element {
  const [local, setLocal] = useState(value);
  const dragging = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!dragging.current) setLocal(value);
  }, [value]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  /** 百分比用于渐变填充 */
  const pct = max === min ? 0 : ((local - min) / (max - min)) * 100;

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-[11.5px] text-ink-2">{label}</span>
        <span className="num text-[11.5px] text-ink">{format ? format(local) : local}</span>
      </div>
      <input
        type="range"
        className="range"
        min={min}
        max={max}
        step={step}
        value={local}
        aria-label={label}
        style={{
          background: `linear-gradient(to right, color-mix(in oklab, var(--color-accent) 65%, transparent) ${pct}%, transparent ${pct}%)`,
          backgroundSize: '100% 3px',
          backgroundPosition: '0 center',
          backgroundRepeat: 'no-repeat',
        }}
        onChange={(e) => {
          const next = Number(e.target.value);
          dragging.current = true;
          setLocal(next);
          onChange(next);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => {
            dragging.current = false;
            onCommit?.(next);
          }, commitDelayMs);
        }}
        onPointerUp={() => {
          dragging.current = false;
        }}
        onBlur={() => {
          dragging.current = false;
        }}
      />
    </div>
  );
}

// ------------------------------------------------------------------ 分段控件

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: IconName;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  size = 'md',
}: {
  options: SegmentOption<T>[];
  value: T | null;
  onChange: (v: T | null) => void;
  size?: 'sm' | 'md';
}): JSX.Element {
  return (
    <div
      className="inline-flex items-center gap-0.5 rounded-lg border border-line bg-sunken p-0.5"
      role="group"
    >
      {options.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(active ? null : opt.value)}
            className={`inline-flex items-center gap-1 rounded-md px-2 transition-colors ${
              size === 'sm' ? 'h-[22px] text-[11px]' : 'h-[26px] text-[11.5px]'
            } ${active ? 'bg-raised text-ink' : 'text-ink-3 hover:text-ink-2'}`}
            style={active ? { boxShadow: 'inset 0 0 0 1px var(--color-line-strong)' } : undefined}
          >
            {opt.icon ? <Icon name={opt.icon} size={12} /> : null}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ 其它

export function IconButton({
  icon,
  label,
  onClick,
  active = false,
  className = '',
  size = 16,
  disabled = false,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  active?: boolean;
  className?: string;
  size?: number;
  disabled?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border transition-colors ${
        active
          ? 'border-line-strong bg-raised text-ink'
          : 'border-transparent text-ink-3 hover:border-line hover:bg-white/[0.04] hover:text-ink'
      } ${disabled ? 'cursor-not-allowed opacity-40' : ''} ${className}`}
    >
      <Icon name={icon} size={size} />
    </button>
  );
}

export function Spinner({ size = 14, className = '' }: { size?: number; className?: string }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={`animate-spin ${className}`}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.4" opacity="0.22" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

/** 分隔线 + 小标题 */
export function SectionHead({
  title,
  right,
  hint,
}: {
  title: string;
  right?: ReactNode;
  hint?: string;
}): JSX.Element {
  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <div className="flex items-baseline gap-2">
        <h3 className="text-[12.5px] font-semibold tracking-tight text-ink">{title}</h3>
        {hint ? <span className="text-[10.5px] text-ink-3">{hint}</span> : null}
      </div>
      {right}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }): JSX.Element {
  return <kbd className="kbd">{children}</kbd>;
}
