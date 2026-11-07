/**
 * 列表语言切换（原文 / 中文）：出现在论文/新闻页工具栏与设置页。
 * 选择存 localStorage（lib/lang.ts），跨页面记忆。
 */
import { useSyncExternalStore, type JSX } from 'react';
import { getListLang, setListLang, subscribeListLang, type ListLang } from '../lib/lang';

const OPTIONS: { value: ListLang; label: string }[] = [
  { value: 'original', label: '原文' },
  { value: 'zh', label: '中文' },
];

export function LangToggle({ compact = false }: { compact?: boolean }): JSX.Element {
  const lang = useSyncExternalStore(subscribeListLang, getListLang);
  const size = compact ? 'text-[10px] px-1.5 py-0.5' : 'text-[11px] px-2.5 py-1';

  return (
    <div
      role="radiogroup"
      aria-label="列表语言"
      className={`inline-flex items-center gap-0.5 rounded-md border border-line bg-sunken ${size}`}
    >
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={lang === option.value}
          onClick={() => setListLang(option.value)}
          className={`rounded-[5px] px-2 py-0.5 transition-colors ${
            lang === option.value
              ? 'bg-fill-2 font-medium text-ink'
              : 'text-ink-3 hover:text-ink-2'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
