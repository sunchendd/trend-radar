/**
 * Browser half of the trend-radar bundle: one sidebar entry and the dashboard
 * page it opens.
 *
 * The page is a thin shell. The dashboard itself is the built SPA served by
 * `server/dist/index.js`, reached through the Host's `/trend-radar` proxy, so
 * it stays on the same origin as the Harness window — no extra port to
 * remember, and SSE (live collection events) flows through the same origin.
 *
 * The Host guarantees the server process is running before proxying, so this
 * page only needs to know: is it up, and what should the frame point at.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-trend-radar',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    /** Locale namespace owned by this plugin. */
    const NS = 'trendradar';
    /** Shared by the sidebar entry and the page it opens. */
    const PANEL_ID = 'trend-radar';
    /** Mounted dashboard (same origin, no port). */
    const MOUNT = '/trend-radar';
    /** Host action route. */
    const ROUTE = '/api/trend-radar';

    const zh = {
      panel: '情报雷达',
      starting: '正在打开情报看板…',
      failed: '情报看板没打开',
      retry: '重试',
      emptyTitle: '情报雷达已就绪',
      emptyBody: '两步上手：\n① 点「采集」跑一轮（arXiv / GitHub Releases / RSS）。\n② 设置页配置 LLM 与查新 CLI 后，即可生成专利选题并导出交底书。\n\n配置一次即可，后续打开侧边栏直接使用。',
    };

    const en = {
      panel: 'Trend Radar',
      starting: 'Opening the dashboard…',
      failed: 'The dashboard did not open',
      retry: 'Retry',
      emptyTitle: 'Trend Radar is ready',
      emptyBody: 'Two steps to start:\n① Click "Collect" to run one round (arXiv / GitHub Releases / RSS).\n② Configure the LLM and novelty-check CLI in Settings to generate patent ideas and export disclosures.\n\nConfigure once — the sidebar opens straight into the dashboard afterwards.',
    };

    const CSS = `
      /* main 插槽契约（reports/04-panel-nav.md）：插槽包装层不是定位上下文，
         根容器必须普通流式 + height:100% 贴合容器——绝对定位铺满会锚到上层定位
         祖先盖住 shell 侧边栏（USER-2 同款 bug）。导航 = 侧边栏本身，保持可见可点。
         不提供"新窗口打开/复制链接"之类的出口——用户要的是在 Harness 里看。 */
      .dshRadar {
        height: 100%; box-sizing: border-box; display: flex; min-height: 0; min-width: 0;
        overflow: hidden;
        background: var(--dsw-alias-bg-base, #0b0d10);
      }
      .dshRadarFrame { flex: 1; min-width: 0; min-height: 0; border: 0; background: #fbfbfd; }
      .dshRadarEmpty {
        flex: 1; display: grid; place-content: center; gap: 10px;
        text-align: center; padding: 30px;
      }
      .dshRadarEmptyTitle { font: 600 14px/1.4 inherit; color: var(--dsw-alias-text-l1, #e9edf3); }
      .dshRadarEmptyBody {
        font: 12px/1.8 inherit; color: var(--dsw-alias-text-l3, #8b93a1);
        max-width: 520px; white-space: pre-wrap;
      }
      .dshRadarBtn {
        justify-self: center; font: 500 11.5px/1 inherit; padding: 6px 12px; border-radius: 6px;
        cursor: pointer; color: var(--dsw-alias-text-l2, #c6ccd6);
        background: var(--dsw-alias-bg-l2, #14181e);
        border: 1px solid var(--dsw-alias-border-l2, #2a2f38);
      }
      .dshRadarBtn:hover { color: var(--dsw-alias-text-l1, #fff); border-color: var(--dsw-alias-border-l3, #3a4150); }
    `;

    /** 雷达三弧 + 扫描线 + 回波点（与 icon.svg 同形）。 */
    function PanelIcon(props) {
      const size = props?.size ?? 20;
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true,
        style: { display: 'block', color: props?.active === true ? 'var(--dsw-alias-brand-primary)' : 'currentColor' },
      },
      h('path', { d: 'M12 3.4 A8.6 8.6 0 1 1 3.4 12', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, opacity: 0.7 }),
      h('path', { d: 'M12 7.1 A4.9 4.9 0 1 0 16.9 12', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, opacity: 0.45 }),
      h('path', { d: 'M12 12 L16.9 7.1', stroke: 'currentColor', strokeWidth: 1.5, opacity: 0.9, strokeLinecap: 'round' }),
      h('circle', { cx: 9, cy: 14.6, r: 1.2, fill: 'currentColor', opacity: 0.9 }));
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'trend-radar: dictionaries');
        const t = ctx.locale.bind(NS);

        async function call(action) {
          const response = await fetch(ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action }),
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok || data?.error !== undefined) throw new Error(data?.error ?? `HTTP ${response.status}`);
          return data;
        }

        function RadarPage() {
          /** '' | 'starting' | 'running' | 'failed' */
          const [phase, setPhase] = useState('');
          const [detail, setDetail] = useState('');
          const [nonce, setNonce] = useState(0);
          const mounted = useRef(true);

          const boot = useCallback(async () => {
            setPhase('starting');
            setDetail('');
            try {
              const state = await call('start');
              if (!mounted.current) return;
              if (state.running !== true) throw new Error(state.error ?? '服务没有启动');
              setNonce((value) => value + 1);
              setPhase('running');
            } catch (error) {
              if (!mounted.current) return;
              setPhase('failed');
              setDetail(String(error?.message ?? error));
            }
          }, []);

          useEffect(() => {
            mounted.current = true;
            boot();
            return () => { mounted.current = false; };
          }, [boot]);

          return h('div', { className: 'dshRadar' },
            h('style', null, CSS),
            phase === 'running'
              ? h('iframe', {
                className: 'dshRadarFrame',
                key: nonce,
                src: `${MOUNT}/`,
                title: t('panel'),
                // allow-same-origin 是必须的（看板要读写自己的 /api 与 SSE）；
                // 不放 allow-popups / allow-top-navigation —— 里面任何跳转都不能把
                // Harness 窗口带到别的地址去。allow-downloads 供导出/交底书落盘。
                sandbox: 'allow-scripts allow-same-origin allow-forms allow-modals allow-downloads',
              })
              : h('div', { className: 'dshRadarEmpty' },
                h('div', { className: 'dshRadarEmptyTitle' },
                  phase === 'failed' ? t('failed') : phase === 'starting' ? t('starting') : t('emptyTitle')),
                phase === 'failed' && detail === ''
                  ? null
                  : h('div', { className: 'dshRadarEmptyBody' },
                    phase === 'failed' ? detail : t('emptyBody')),
                h('button', { className: 'dshRadarBtn', onClick: boot }, t('retry'))));
        }

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 22,
          label: () => t('panel'),
          locale: NS,
        }, PanelIcon));

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
        }, RadarPage));
      },
    };
  },
});
