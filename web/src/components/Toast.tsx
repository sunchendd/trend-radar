/**
 * 轻量 Toast：一个 context + 定时器，无依赖。
 * tone 决定色条与图标；error 停留更久。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { Icon, type IconName } from './Icon';

export type ToastTone = 'ok' | 'error' | 'info' | 'warn';

export interface ToastInput {
  title: string;
  detail?: string;
  tone?: ToastTone;
  /** ms；不传按 tone 取默认值 */
  duration?: number;
}

interface ToastItem extends Required<Pick<ToastInput, 'title' | 'tone'>> {
  id: number;
  detail?: string;
  duration: number;
  leaving: boolean;
}

const TONE: Record<ToastTone, { color: string; bg: string; border: string; icon: IconName }> = {
  ok: {
    color: 'var(--color-accent)',
    bg: 'color-mix(in oklab, var(--color-accent) 8%, var(--color-surface))',
    border: 'color-mix(in oklab, var(--color-accent) 38%, transparent)',
    icon: 'check',
  },
  error: {
    color: 'var(--color-danger)',
    bg: 'color-mix(in oklab, var(--color-danger) 9%, var(--color-surface))',
    border: 'color-mix(in oklab, var(--color-danger) 40%, transparent)',
    icon: 'alert',
  },
  warn: {
    color: 'var(--color-warn)',
    bg: 'color-mix(in oklab, var(--color-warn) 9%, var(--color-surface))',
    border: 'color-mix(in oklab, var(--color-warn) 38%, transparent)',
    icon: 'alert',
  },
  info: {
    color: 'var(--color-info)',
    bg: 'color-mix(in oklab, var(--color-info) 8%, var(--color-surface))',
    border: 'color-mix(in oklab, var(--color-info) 32%, transparent)',
    icon: 'info',
  },
};

type Push = (t: ToastInput) => void;

const ToastCtx = createContext<Push>(() => {});

export function useToast(): Push {
  return useContext(ToastCtx);
}

export function ToastProvider({ children }: { children: ReactNode }): JSX.Element {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
    setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), 180);
  }, []);

  const push = useCallback<Push>(
    (input) => {
      const tone = input.tone ?? 'info';
      const duration = input.duration ?? (tone === 'error' ? 6500 : 3800);
      seq.current += 1;
      const id = seq.current;
      const item: ToastItem = {
        id,
        title: input.title,
        tone,
        duration,
        leaving: false,
        ...(input.detail ? { detail: input.detail } : {}),
      };
      setItems((prev) => [...prev.slice(-3), item]);
    },
    [],
  );

  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div
        className="pointer-events-none fixed right-3 bottom-16 z-[80] flex w-[min(92vw,380px)] flex-col gap-2 md:bottom-5"
        role="region"
        aria-label="通知"
        // 只读屏播报需要 aria-live：role=region 不会把新插入的内容念出来
        aria-live="polite"
        aria-atomic="false"
      >
        {items.map((t) => (
          <ToastCard key={t.id} item={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

function ToastCard({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }): JSX.Element {
  const tone = TONE[item.tone];
  useEffect(() => {
    const t = setTimeout(onDismiss, item.duration);
    return () => clearTimeout(t);
  }, [item.duration, onDismiss]);

  return (
    <div
      className="pointer-events-auto overflow-hidden rounded-xl border backdrop-blur-md transition-all duration-200"
      style={{
        borderColor: tone.border,
        background: tone.bg,
        boxShadow: 'var(--shadow-pop)',
        opacity: item.leaving ? 0 : 1,
        transform: item.leaving ? 'translateY(6px)' : 'translateY(0)',
      }}
    >
      <div className="flex gap-2.5 px-3 py-2.5">
        <span className="mt-[1px] shrink-0" style={{ color: tone.color }}>
          <Icon name={tone.icon} size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] leading-[1.45] font-medium text-ink">{item.title}</div>
          {item.detail ? (
            <div className="mt-0.5 text-[11.5px] leading-[1.5] text-ink-2">{item.detail}</div>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="关闭通知"
          className="-mt-0.5 -mr-1 h-6 w-6 shrink-0 rounded-md text-ink-3 transition-colors hover:bg-white/5 hover:text-ink"
        >
          <Icon name="x" size={13} className="mx-auto" />
        </button>
      </div>
      <div style={{ height: 2, background: 'transparent' }}>
        <div
          style={{
            height: 2,
            width: '100%',
            background: tone.color,
            opacity: 0.35,
            transformOrigin: 'left',
            animation: `toast-bar ${item.duration}ms linear forwards`,
          }}
        />
      </div>
      <style>{`@keyframes toast-bar { from { transform: scaleX(1) } to { transform: scaleX(0) } }`}</style>
    </div>
  );
}

/** 便捷包装：collect/generate 等动作统一从这里出提示 */
export function useToastFns(): {
  ok: (title: string, detail?: string) => void;
  error: (title: string, detail?: string) => void;
  info: (title: string, detail?: string) => void;
  warn: (title: string, detail?: string) => void;
} {
  const push = useToast();
  return useMemo(
    () => ({
      ok: (title, detail) => push({ title, tone: 'ok', ...(detail ? { detail } : {}) }),
      error: (title, detail) => push({ title, tone: 'error', ...(detail ? { detail } : {}) }),
      info: (title, detail) => push({ title, tone: 'info', ...(detail ? { detail } : {}) }),
      warn: (title, detail) => push({ title, tone: 'warn', ...(detail ? { detail } : {}) }),
    }),
    [push],
  );
}
