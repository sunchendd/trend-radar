/**
 * 列表语言视图（原文/中文）的全局小状态。
 *
 * 为什么不用 context/状态库：一个布尔偏好 + localStorage 记忆，用模块级
 * 订阅模型（useSyncExternalStore）最省；ItemCard/ItemDrawer/工具栏三处共享。
 */

export type ListLang = 'original' | 'zh';

const STORAGE_KEY = 'tr-lang';
const listeners = new Set<() => void>();

// t24：默认中文视图（用户明确要求）；localStorage 里显式选过「原文」的仍尊重选择
function read(): ListLang {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'original' ? 'original' : 'zh';
  } catch {
    return 'zh';
  }
}

let current: ListLang = typeof localStorage === 'undefined' ? 'zh' : read();

export function getListLang(): ListLang {
  return current;
}

export function setListLang(lang: ListLang): void {
  if (lang === current) return;
  current = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // 隐私模式等存不了就算了：会话内切换仍然生效
  }
  for (const listener of listeners) listener();
}

export function subscribeListLang(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 某条目在当前视图下是否有中文可看（没有就回落原文，不给空态） */
export function hasZh(item: { titleZh?: string; summaryZh?: string }): boolean {
  return current === 'zh' && (item.titleZh !== undefined || item.summaryZh !== undefined);
}
