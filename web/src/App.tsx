/**
 * 应用骨架：导航 + 顶栏 + 页面路由（hash）+ SSE 实时通道 + 全局快捷键。
 *
 * 路由用 hash 而不是 path：后端以静态方式托管 dist 时不需要任何 rewrite 规则。
 */
import { useCallback, useEffect, useState, type JSX } from 'react';
import { Icon } from './components/Icon';
import { HelpOverlay } from './components/Overlay';
import { MobileTabs, NavRail, TopBar } from './components/Nav';
import { ToastProvider } from './components/Toast';
import { subscribeEvents, type StreamEvent } from './lib/api';
import { useDemoMode, useHashRoute, useHotkeys, type RouteName } from './lib/hooks';
import type { IdeaWithVerdict } from './lib/types';
import { IdeasPage } from './pages/IdeasPage';
import { NewsPage } from './pages/NewsPage';
import { PapersPage } from './pages/PapersPage';
import { SettingsPage } from './pages/SettingsPage';
import { SystemPage } from './pages/SystemPage';
import { WatchPage } from './pages/WatchPage';

export function App(): JSX.Element {
  const { route, navigate } = useHashRoute();
  const demo = useDemoMode();
  const [helpOpen, setHelpOpen] = useState(false);
  const [stream, setStream] = useState<'open' | 'polling'>('polling');
  const [live, setLive] = useState<{
    nonce: number;
    kind: StreamEvent['type'] | null;
    idea: IdeaWithVerdict | null;
  }>({ nonce: 0, kind: null, idea: null });

  // SSE：实时通道。组件卸载 / 页面关闭时清理连接。
  useEffect(() => {
    const close = subscribeEvents(
      (e) => {
        setLive((prev) => ({
          nonce: prev.nonce + 1,
          kind: e.type,
          idea: e.type === 'idea' ? e.data : prev.idea,
        }));
      },
      (s) => setStream(s === 'open' ? 'open' : 'polling'),
    );
    return close;
  }, []);

  const go = useCallback(
    (name: RouteName, params?: Record<string, string>) => {
      navigate(name, params);
      window.scrollTo({ top: 0 });
    },
    [navigate],
  );

  useHotkeys(
    [
      { key: '1', run: () => go('papers') },
      { key: '2', run: () => go('news') },
      { key: '3', run: () => go('ideas') },
      { key: '4', run: () => go('watch') },
      { key: '5', run: () => go('system') },
      { key: ',', run: () => go('settings') },
      { key: '?', run: () => setHelpOpen((v) => !v) },
    ],
    !helpOpen,
  );

  return (
    <ToastProvider>
      <div className="flex min-h-dvh">
        {/* 键盘用户第一下 Tab 就能跳过导航直达内容：四个页面 + 长列表，跳过去很省力 */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[90] focus:rounded-md focus:border focus:border-accent/50 focus:bg-panel focus:px-3 focus:py-1.5 focus:text-[12px] focus:text-accent"
        >
          跳到主要内容
        </a>
        <NavRail
          current={route.name}
          onNavigate={go}
          onHelp={() => setHelpOpen(true)}
          stream={stream}
        />

        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar
            route={route.name}
            demo={demo}
            stream={stream}
            onHelp={() => setHelpOpen(true)}
            onSettings={() => go('settings')}
          />

          {demo ? <DemoBanner /> : null}

          <main id="main" tabIndex={-1} className="min-w-0 flex-1 pb-14 outline-none md:pb-0">
            {route.name === 'papers' ? (
              <PapersPage route={route} demo={demo} liveNonce={live.nonce} onHelp={() => setHelpOpen(true)} />
            ) : route.name === 'news' ? (
              <NewsPage route={route} demo={demo} liveNonce={live.nonce} onHelp={() => setHelpOpen(true)} />
            ) : route.name === 'settings' ? (
              <SettingsPage
                liveNonce={live.nonce}
                onBack={() => go('papers')}
                onSaved={() => setLive((prev) => ({ ...prev, nonce: prev.nonce + 1 }))}
              />
            ) : route.name === 'ideas' ? (
              <IdeasPage route={route} navigate={go} liveNonce={live.nonce} liveIdea={live.idea} />
            ) : route.name === 'watch' ? (
              <WatchPage liveNonce={live.nonce} navigate={go} />
            ) : (
              <SystemPage liveNonce={live.nonce} />
            )}
          </main>
        </div>
      </div>

      <MobileTabs current={route.name} onNavigate={go} />
      <HelpOverlay open={helpOpen} onClose={() => setHelpOpen(false)} />
    </ToastProvider>
  );
}

/** 演示模式横幅：绝不静默 — 顶部常驻，直到真接口可用 */
function DemoBanner(): JSX.Element {
  return (
    <div
      className="flex items-center gap-2 border-b px-3 py-1.5 md:px-5"
      style={{
        background: 'color-mix(in oklab, var(--color-warn) 8%, var(--color-canvas))',
        borderColor: 'color-mix(in oklab, var(--color-warn) 24%, transparent)',
      }}
      role="status"
    >
      <Icon name="flask" size={12} className="shrink-0 text-warn" />
      <span className="min-w-0 flex-1 truncate text-[11px] text-ink-2">
        后端未启动，正在用<strong className="mx-1 font-medium text-warn">演示数据</strong>渲染界面（只在开发模式兜底，不写库）。
      </span>
      <code className="num hidden shrink-0 rounded border border-line bg-sunken px-1.5 py-[1px] text-[10.5px] text-accent sm:inline">
        npm run dev:server
      </code>
    </div>
  );
}
