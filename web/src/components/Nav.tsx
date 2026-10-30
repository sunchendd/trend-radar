/**
 * 导航骨架：左侧窄导航（桌面）/ 底部 Tab（手机）/ 顶部状态条。
 *
 * 论文与新闻是两个**独立页面**（`#/papers` / `#/news`）：两者的数据源、
 * KPI 口径都不同，混在一个「情报流」里会让人看不出今天该读哪一类。
 * 全局设置（采集调度 / LLM / 查新）是低频操作，放右上角齿轮，不占主导航位。
 */
import type { JSX, ReactNode } from 'react';
import { BrandMark, Icon, type IconName } from './Icon';
import { Pill } from './primitives';
import { demoReasonText } from '../lib/api';
import type { PageRoute, RouteName } from '../lib/hooks';
import { useTheme } from '../lib/theme';

const NAV: { name: PageRoute; label: string; icon: IconName; hint: string }[] = [
  { name: 'papers', label: '论文', icon: 'doc', hint: 'arXiv 等论文源，按相关度排序' },
  { name: 'news', label: '新闻', icon: 'feed', hint: 'GitHub Releases 与工程博客' },
  { name: 'ideas', label: '选题', icon: 'bulb', hint: '把情报变成可查新的专利选题' },
  { name: 'watch', label: '巡检', icon: 'flame', hint: '盯住方向，命中数异动就是选题信号' },
  { name: 'system', label: '信源', icon: 'antenna', hint: '信源启停与采集日志' },
];

export const PAGE_TITLE: Record<PageRoute, { title: string; sub: string }> = {
  papers: { title: '论文', sub: 'arXiv 等论文源 · 按相关度排序，先读高分的那几条' },
  news: { title: '新闻', sub: 'GitHub Releases + 工程博客 · 工程信号比论文更早暴露实现细节' },
  ideas: { title: '选题工作台', sub: '查新、判读、交底书素材' },
  watch: { title: '检索式巡检', sub: '命中数环比异动 → 选题触发器' },
  system: { title: '信源与日志', sub: '抓取健康度与运行记录' },
  settings: { title: '设置', sub: '采集调度、KPI 口径、LLM 与查新 CLI' },
};

export function pageTitleOf(route: RouteName): { title: string; sub: string } {
  return PAGE_TITLE[route];
}

/** 齿轮：设置入口。Icon.tsx 里没有 gear，就地内联一个（同一套 24×24 / 1.6 描边） */
function GearIcon({ size = 15 }: { size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3.1" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.11A1.7 1.7 0 0 0 9.9 19.3a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 5.54 15a1.7 1.7 0 0 0-1.56-1.03H4a2 2 0 1 1 0-4h.11A1.7 1.7 0 0 0 5.7 9.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H10a1.7 1.7 0 0 0 1.03-1.56V4a2 2 0 1 1 4 0v.11a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V10a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.11A1.7 1.7 0 0 0 19.4 15Z" />
    </svg>
  );
}

export function NavRail({
  current,
  onNavigate,
  onHelp,
  stream,
}: {
  current: RouteName;
  onNavigate: (n: PageRoute) => void;
  onHelp: () => void;
  stream: 'open' | 'polling';
}): JSX.Element {
  return (
    <nav
      className="sticky top-0 hidden h-dvh w-[74px] shrink-0 flex-col items-center border-r border-line py-4 md:flex"
      aria-label="主导航"
    >
      <a
        href="#/papers"
        className="mb-5 flex flex-col items-center gap-1 text-ink"
        onClick={(e) => {
          e.preventDefault();
          onNavigate('papers');
        }}
        aria-label="Trend Radar 首页"
      >
        <BrandMark size={27} />
        <span className="text-[8.5px] font-semibold tracking-[0.13em] text-ink-3">RADAR</span>
      </a>

      <div className="scroll-area flex w-full flex-col items-center gap-1 overflow-y-auto">
        {NAV.map((item, i) => {
          const active = current === item.name;
          return (
            <button
              key={item.name}
              type="button"
              onClick={() => onNavigate(item.name)}
              title={`${item.hint}（${i + 1}）`}
              aria-current={active ? 'page' : undefined}
              className={`group relative flex w-[54px] flex-col items-center gap-1 rounded-xl py-2 transition-colors ${
                active ? 'text-ink' : 'text-ink-3 hover:bg-fill-1 hover:text-ink-2'
              }`}
            >
              <span
                className="absolute top-1/2 -left-[10px] h-5 w-[2px] -translate-y-1/2 rounded-full transition-all"
                style={{
                  background: active ? 'var(--color-accent)' : 'transparent',
                  boxShadow: active ? '0 0 10px 0 rgb(53 231 197 / 0.75)' : 'none',
                }}
              />
              <span
                className="flex h-7 w-7 items-center justify-center rounded-lg transition-colors"
                style={{
                  background: active ? 'color-mix(in oklab, var(--color-accent) 12%, transparent)' : 'transparent',
                  color: active ? 'var(--color-accent)' : undefined,
                }}
              >
                <Icon name={item.icon} size={17} />
              </span>
              <span className="text-[10px] tracking-wide">{item.label}</span>
            </button>
          );
        })}
      </div>

      <div className="mt-auto flex flex-col items-center gap-3 pt-2">
        <button
          type="button"
          onClick={onHelp}
          title="快捷键（?）"
          aria-label="快捷键帮助"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-3 transition-colors hover:bg-fill-2 hover:text-ink"
        >
          <Icon name="keyboard" size={15} />
        </button>
        <span
          title={stream === 'open' ? 'SSE 已连接' : 'SSE 未连接，30s 轮询兜底'}
          className="mb-1 flex items-center gap-1 text-[9px] text-ink-3"
        >
          <span
            className="inline-block h-[6px] w-[6px] rounded-full"
            style={{
              background: stream === 'open' ? 'var(--color-accent)' : '#4b5c63',
              boxShadow: stream === 'open' ? '0 0 6px 0 rgb(53 231 197 / 0.8)' : 'none',
            }}
          />
          {stream === 'open' ? 'LIVE' : 'POLL'}
        </span>
      </div>
    </nav>
  );
}

export function MobileTabs({
  current,
  onNavigate,
}: {
  current: RouteName;
  onNavigate: (n: PageRoute) => void;
}): JSX.Element {
  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 flex border-t border-line bg-surface/95 backdrop-blur-md md:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      aria-label="底部导航"
    >
      {NAV.map((item) => {
        const active = current === item.name;
        return (
          <button
            key={item.name}
            type="button"
            onClick={() => onNavigate(item.name)}
            aria-current={active ? 'page' : undefined}
            className="flex flex-1 flex-col items-center gap-0.5 py-2"
            style={{ color: active ? 'var(--color-accent)' : 'var(--color-ink-3)' }}
          >
            <Icon name={item.icon} size={18} />
            <span className="text-[10px]">{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

export function DemoBadge(): JSX.Element | null {
  return (
    <Pill
      color="var(--color-warn)"
      bg="color-mix(in oklab, var(--color-warn) 12%, transparent)"
      border="color-mix(in oklab, var(--color-warn) 40%, transparent)"
      title={`${demoReasonText() || '后端不可用'} — 当前展示演示数据，不会写入数据库。`}
      icon="flask"
    >
      演示数据
    </Pill>
  );
}

export function TopBar({
  route,
  demo,
  stream,
  onHelp,
  onSettings,
  right,
}: {
  route: RouteName;
  demo: boolean;
  stream: 'open' | 'polling';
  onHelp: () => void;
  onSettings?: () => void;
  right?: ReactNode;
}): JSX.Element {
  const page = pageTitleOf(route);
  const settingsActive = route === 'settings';
  const { theme, toggle } = useTheme();
  const nextTheme = theme === 'light' ? '深色' : '浅色';
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-canvas/85 backdrop-blur-md">
      <div className="flex h-[52px] items-center gap-3 px-3 md:px-5">
        <div className="flex items-center gap-2 md:hidden">
          <BrandMark size={20} />
        </div>
        <div className="min-w-0">
          <h1 className="truncate text-[15px] leading-tight font-semibold tracking-tight text-ink">{page.title}</h1>
          <p className="hidden truncate text-[10.5px] text-ink-3 sm:block">{page.sub}</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {right}
          {demo ? <DemoBadge /> : null}
          <span
            className="hidden items-center gap-1.5 rounded-md border border-line px-1.5 py-[3px] text-[10px] text-ink-3 sm:flex"
            title={stream === 'open' ? '已通过 SSE 接收实时事件' : 'SSE 未连接，使用 30s 轮询'}
          >
            <span
              className="inline-block h-[5px] w-[5px] rounded-full"
              style={{
                background: stream === 'open' ? 'var(--color-accent)' : '#4b5c63',
              }}
            />
            {stream === 'open' ? '实时' : '轮询'}
          </span>
          <button
            type="button"
            onClick={onHelp}
            className="flex h-7 items-center gap-1 rounded-md border border-line px-1.5 text-[10.5px] text-ink-3 transition-colors hover:border-line-strong hover:text-ink"
            title="快捷键"
          >
            <Icon name="keyboard" size={13} />
            <span className="hidden lg:inline">?</span>
          </button>
          <button
            type="button"
            onClick={toggle}
            aria-label="切换浅色/深色主题"
            title={`当前${theme === 'light' ? '浅色' : '深色'} · 切换到${nextTheme}`}
            className="flex h-7 w-7 items-center justify-center rounded-md border border-line text-ink-3 transition-colors hover:border-line-strong hover:text-ink"
          >
            <Icon name={theme === 'light' ? 'moon' : 'sun'} size={13} />
          </button>
          {onSettings ? (
            <button
              type="button"
              onClick={onSettings}
              aria-label="设置"
              aria-current={settingsActive ? 'page' : undefined}
              title="设置：采集调度 / KPI 口径 / LLM / 查新"
              className="flex h-7 items-center gap-1 rounded-md border px-1.5 text-[10.5px] transition-colors"
              style={{
                borderColor: settingsActive ? 'color-mix(in oklab, var(--color-accent) 45%, transparent)' : 'var(--color-line)',
                color: settingsActive ? 'var(--color-accent)' : 'var(--color-ink-3)',
                background: settingsActive ? 'color-mix(in oklab, var(--color-accent) 10%, transparent)' : 'transparent',
              }}
            >
              <GearIcon size={13} />
              <span className="hidden lg:inline">设置</span>
            </button>
          ) : null}
        </div>
      </div>
    </header>
  );
}
