/**
 * 主题（浅色 / 深色）。
 *
 * 三件事必须一致，所以只有**一份真相**：
 * 1. `<html data-theme>`（CSS 从这里取 token）；
 * 2. `localStorage['tr-theme']`（刷新后恢复，见 index.html 里的内联脚本）；
 * 3. React 侧状态（顶栏太阳/月亮按钮 + 设置页单选，都订阅同一个 store）。
 *
 * 默认浅色：用户反馈「太黑」。深色保留给夜间/大屏使用。
 */
import { useCallback, useSyncExternalStore } from 'react';

export type Theme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'tr-theme';
export const DEFAULT_THEME: Theme = 'light';

const listeners = new Set<() => void>();

function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark';
}

/** 当前生效主题（以 DOM 为准，DOM 又由内联脚本在首帧前写好） */
export function getTheme(): Theme {
  if (typeof document === 'undefined') return DEFAULT_THEME;
  const attr = document.documentElement.getAttribute('data-theme');
  return isTheme(attr) ? attr : DEFAULT_THEME;
}

function notify(): void {
  for (const cb of listeners) cb();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** 应用主题：改 DOM + 落 localStorage + 通知订阅者（三处同时更新） */
export function setTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', theme);
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // 隐私模式 / 配额满：主题依然生效，只是不记忆，不抛错
  }
  notify();
}

export function toggleTheme(): Theme {
  const next: Theme = getTheme() === 'light' ? 'dark' : 'light';
  setTheme(next);
  return next;
}

export interface ThemeState {
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggle: () => void;
}

/** 顶栏按钮与设置页共用这一份状态 */
export function useTheme(): ThemeState {
  const theme = useSyncExternalStore(subscribe, getTheme, () => DEFAULT_THEME);
  const set = useCallback((t: Theme) => setTheme(t), []);
  const toggle = useCallback(() => {
    toggleTheme();
  }, []);
  return { theme, setTheme: set, toggle };
}
