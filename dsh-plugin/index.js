/**
 * Host half of the trend-radar bundle.
 *
 * Owns four things:
 *   1. the local dashboard server (`node server/dist/index.js serve` in this
 *      repo) — started on demand, so opening the sidebar is enough; the process
 *      is detached and survives Harness restarts, a later panel click just
 *      re-probes and reuses it;
 *   2. a `/trend-radar/*` reverse proxy on this server, so the dashboard is
 *      served from the same origin as the Harness window — no port to remember;
 *   3. one `/api/trend-radar` Fetch route (status/start/stop/restart) so the
 *      sidebar page and the agent drive the same code path;
 *   4. eight `trend_*` tools ported 1:1 from the retired `dsh-trend-radar`
 *      web-profile bridge (same names, same parameters, same rendered text).
 *
 * Proxy routing (contract, see reports/02-architecture.md §4.3.2):
 *   ① `text/event-stream` → stream pass-through. Never buffered, never
 *      rewritten: the dashboard pushes collection events over SSE and a
 *      buffered proxy would silently freeze the live feed;
 *   ② other textual responses → buffered + quote-prefix rewrite of the
 *      absolute paths the SPA emits (`/api/`, `/assets/`, `/favicon`);
 *   ③ everything else (docx export, images) → binary pipe.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import net from 'node:net';

export const name = 'trend-radar';
export const inject = ['webServer', 'connection', 'tools'];

/** Same-origin mount point of the dashboard. */
const PREFIX = '/trend-radar';
/** Host action route the sidebar calls. */
const ROUTE = '/api/trend-radar';
/** Actions shared by the route and the management tool. */
const ACTIONS = ['status', 'start', 'stop', 'restart'];
/** Absolute paths the SPA emits that must become prefix-relative. */
const REWRITE_PREFIXES = ['/api/', '/assets/', '/favicon'];
/** SSE is routed first and never enters the textual path. */
const SSE = /text\/event-stream/i;
/** Response types worth buffering for a rewrite; event-stream already left. */
const TEXTUAL = /^(text\/(?!event-stream)|application\/(json|javascript|x-javascript)|image\/svg)/i;
/** Hop-by-hop headers are meaningless across the proxy hop. */
const HOP_BY_HOP = new Set(['connection', 'keep-alive']);

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** Decode a body we intend to rewrite; unknown charsets are treated as UTF-8. */
function decode(buffer, contentType) {
  const charset = /charset=([\w-]+)/i.exec(contentType)?.[1]?.toLowerCase() ?? 'utf-8';
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return buffer.toString('utf8');
  }
}

/** Point every absolute dashboard path at the mounted prefix. */
export function rewrite(body) {
  let out = body;
  for (const prefix of REWRITE_PREFIXES) {
    // Only rewrite when the path starts right after a quote or a parenthesis:
    // that covers href/src attributes, string literals and template strings
    // while leaving prose like "见 /api/ 文档" alone.
    const pattern = new RegExp(`([\\"'\`(])${prefix.replace(/\//g, '\\/')}`, 'g');
    out = out.replace(pattern, `$1${PREFIX}${prefix}`);
  }
  return out;
}

/** Let config values like `dataDir: ~/.trend-radar` work as written. */
function expandHome(value) {
  if (typeof value !== 'string' || value === '') return value;
  return value.startsWith('~') ? join(homedir(), value.slice(1)) : value;
}

/* ---------- 渲染辅助（自旧工具桥 lib/index.js 原样平移） ---------- */

const NL = '\n';

function dayOf(iso) {
  return (iso || '').slice(0, 10);
}

function lineOf(arr) {
  return (arr || []).join('、');
}

function renderItems(value) {
  const lines = [];
  const items = (value && value.items) || (Array.isArray(value) ? value : []);
  lines.push('共 ' + ((value && value.total != null ? value.total : items.length)) + ' 条，显示 ' + items.length + ' 条：');
  items.forEach(function (it) {
    lines.push('- [' + it.score + '] ' + it.title + '（' + it.sourceId + ' ' + dayOf(it.publishedAt) + '）');
    if (it.summary) lines.push('  ' + String(it.summary).slice(0, 120));
  });
  return lines;
}

function renderIdea(idea, verbose) {
  const lines = ['- [' + idea.status + '] ' + idea.title + '（id ' + idea.id + ' ' + dayOf(idea.createdAt) + '）'];
  if (verbose) {
    if (idea.problem) lines.push('  问题：' + String(idea.problem).slice(0, 160));
    if (idea.solution) lines.push('  方案：' + String(idea.solution).slice(0, 160));
    if (idea.effect) lines.push('  效果：' + String(idea.effect).slice(0, 120));
    if (idea.queries && idea.queries.length) lines.push('  检索式：' + lineOf(idea.queries));
    if (idea.risks && idea.risks.length) lines.push('  撞车风险：' + lineOf(idea.risks));
    if (idea.ipcHints && idea.ipcHints.length) lines.push('  IPC：' + lineOf(idea.ipcHints));
  }
  return lines;
}

export function apply(ctx, config = {}) {
  const port = Number(config.port ?? 8787);
  // 插件目录在仓库内（<repo>/dsh-plugin），上一级即仓库根——零配置且跟随仓库移动。
  // config.repo 仅在仓库被挪出插件相对位置时才需要显式指定。
  const repo = typeof config.repo === 'string' && config.repo !== ''
    ? expandHome(config.repo)
    : join(dirname(fileURLToPath(import.meta.url)), '..');
  const dataDir = typeof config.dataDir === 'string' && config.dataDir !== ''
    ? expandHome(config.dataDir)
    : join(homedir(), '.trend-radar');
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const logPath = join(home, 'trend-radar', 'server.log');

  const entry = join(repo, 'server', 'dist', 'index.js');
  // 兼容回退：旧工具桥时代的服务副本（同 commit 的构建产物）。
  const skillRoot = join(homedir(), '.agents', 'skills', 'trend-radar');
  const skillEntry = join(skillRoot, 'server', 'dist', 'index.js');
  const installed = existsSync(entry) || existsSync(skillEntry);

  /** Spawned child, when this plugin owns the process. */
  let child = null;
  /** In-flight start promise, so concurrent callers share one spawn. */
  let starting = null;

  /** Prefer the repo's own build output; fall back to the old skills copy. */
  function spawnSource() {
    if (existsSync(entry)) return { entry, cwd: repo, from: 'repo' };
    if (existsSync(skillEntry)) return { entry: skillEntry, cwd: skillRoot, from: 'skills' };
    return null;
  }

  /** True when the dashboard answers /api/health with {ok:true}. */
  function probe(timeout = 1200) {
    return new Promise((resolveProbe) => {
      const request = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          let ok = false;
          try {
            ok = response.statusCode === 200 && JSON.parse(Buffer.concat(chunks).toString('utf8')).ok === true;
          } catch {
            ok = false;
          }
          resolveProbe(ok);
        });
        response.on('error', () => resolveProbe(false));
      });
      request.on('timeout', () => { request.destroy(); resolveProbe(false); });
      request.on('error', () => resolveProbe(false));
    });
  }

  /** True when something (anything) accepts TCP on the dashboard port. */
  function portOccupied(timeoutMs = 800) {
    return new Promise((resolveOcc) => {
      const socket = net.connect({ host: '127.0.0.1', port, timeout: timeoutMs });
      socket.once('connect', () => { socket.destroy(); resolveOcc(true); });
      socket.once('timeout', () => { socket.destroy(); resolveOcc(false); });
      socket.once('error', () => resolveOcc(false));
    });
  }

  async function waitUntilUp(ms = 12000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await probe(600)) return true;
      await new Promise((resolveWait) => setTimeout(resolveWait, 300));
    }
    return false;
  }

  /** Spawn `server/dist/index.js serve` (detached, log into $DSH_HOME). */
  async function doStart() {
    if (!installed) {
      return { running: false, port, installed: false,
        error: `服务未构建：${entry} 不存在。先在仓库 ${repo} 执行 npm install && npm run build，再点「启动」。` };
    }
    const source = spawnSource();
    mkdirSync(dirname(logPath), { recursive: true });
    const logFd = openSync(logPath, 'a');
    child = spawn(process.execPath, [source.entry, 'serve'], {
      cwd: source.cwd,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', TREND_RADAR_DATA_DIR: dataDir },
    });
    child.unref();
    const up = await waitUntilUp();
    if (!up) {
      // 端口被别的东西占着时 spawn 会 EADDRINUSE 退出：给可操作错误，不静默。
      const occupied = await portOccupied();
      return { running: false, port, spawned: true, pid: child?.pid, log: logPath,
        error: occupied
          ? `端口 ${port} 被占用但不是情报雷达服务：lsof -nP -iTCP:${port} -sTCP:LISTEN 查看占用者，结束它，或在 cordis.patch.yml 里改 config.port 后重启 Harness。`
          : `启动 12 秒仍未响应，看日志：${logPath}` };
    }
    return { running: true, port, spawned: true, pid: child?.pid, entry: source.entry, dataDir, log: logPath };
  }

  /** Start the dashboard if it is not already listening (reuses foreign instances). */
  async function start() {
    if (await probe()) return { running: true, port, spawned: false };
    if (starting) return starting;
    starting = doStart().finally(() => { starting = null; });
    return starting;
  }

  function stop() {
    if (child === null) return { running: false, stopped: false, reason: '这个进程不是插件启动的' };
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
    }
    child = null;
    return { running: false, stopped: true };
  }

  async function status() {
    const running = await probe();
    return {
      running,
      installed,
      repo,
      port,
      url: `${PREFIX}/`,
      dataDir,
      log: logPath,
      entry: spawnSource()?.entry ?? entry,
      ownedByPlugin: child !== null,
    };
  }

  async function run(action) {
    switch (action) {
      case 'status': return status();
      case 'start': return start();
      case 'stop': return stop();
      case 'restart': stop(); return start();
      default: throw new Error(`unhandled action: ${action}`);
    }
  }

  /** Tools: every API call is preceded by an on-demand server start. */
  async function ensureServer() {
    if (await probe()) return;
    const started = await start();
    if (!started.running) throw new Error(started.error ?? '情报雷达服务未能启动');
  }

  function fetchApi(path, init, timeoutMs) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs || 30000);
    return fetch(`http://127.0.0.1:${port}${path}`, Object.assign({ signal: ctl.signal }, init))
      .then(async (res) => {
        const text = await res.text();
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch (e) { body = { raw: text }; }
        if (!res.ok) {
          const b = body || {};
          const msg = b.message || b.error || (b.raw && b.raw.slice(0, 200)) || 'HTTP ' + res.status;
          const err = new Error(msg);
          err.status = res.status;
          throw err;
        }
        return body;
      })
      .finally(() => clearTimeout(timer));
  }

  async function toolStatus() {
    await ensureServer();
    const out = { baseUrl: `http://127.0.0.1:${port}` };
    out.health = await fetchApi('/api/health', null, 5000);
    out.stats = await fetchApi('/api/stats', null, 10000).catch(() => null);
    out.sources = await fetchApi('/api/sources', null, 10000).catch(() => null);
    out.runs = await fetchApi('/api/runs', null, 10000).catch(() => null);
    return out;
  }

  async function toolCollect(sourceIds) {
    await ensureServer();
    const body = {};
    if (Array.isArray(sourceIds) && sourceIds.length > 0) body.sourceIds = sourceIds;
    return fetchApi('/api/collect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, 240000);
  }

  async function toolItems(args) {
    await ensureServer();
    const q = new URLSearchParams();
    if (args.q) q.set('q', args.q);
    if (args.kind) q.set('kind', args.kind);
    if (typeof args.minScore === 'number') q.set('minScore', String(args.minScore));
    if (args.since) q.set('since', args.since);
    if (args.sort) q.set('sort', args.sort);
    q.set('limit', String(args.limit || 15));
    q.set('offset', String(args.offset || 0));
    return fetchApi('/api/items?' + q.toString(), null, 60000);
  }

  async function toolIdeas(status) {
    await ensureServer();
    const suffix = status ? '?status=' + encodeURIComponent(status) : '';
    return fetchApi('/api/ideas' + suffix, null, 30000);
  }

  async function toolGenerate(args) {
    await ensureServer();
    const body = { focus: args.focus, count: args.count || 3 };
    if (Array.isArray(args.itemIds) && args.itemIds.length > 0) body.itemIds = args.itemIds;
    return fetchApi('/api/ideas/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, 300000);
  }

  async function toolIdeaDetail(args) {
    await ensureServer();
    const out = await fetchApi('/api/ideas/' + encodeURIComponent(args.id), null, 30000);
    if (args.runNovelty) {
      out.novelty = await fetchApi('/api/ideas/' + encodeURIComponent(args.id) + '/novelty/auto', { method: 'POST' }, 120000)
        .catch((e) => ({ error: String((e && e.message) || e) }));
    }
    if (args.disclosure) {
      out.disclosure = await fetchApi('/api/ideas/' + encodeURIComponent(args.id) + '/disclosure', null, 30000)
        .catch((e) => ({ error: String((e && e.message) || e) }));
    }
    return out;
  }

  async function toolWatch(args) {
    await ensureServer();
    const action = args.action || 'list';
    if (action === 'list') {
      return fetchApi('/api/watches' + (args.all === true ? '?all=true' : ''), null, 30000);
    }
    if (action === 'add') {
      const body = { query: args.query };
      if (args.note) body.note = args.note;
      return fetchApi('/api/watches', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, 30000);
    }
    if (action === 'sweep') {
      return fetchApi('/api/watches/sweep', { method: 'POST' }, 180000);
    }
    return { error: 'action 只能是 list | add | sweep' };
  }

  /* ---------- 反代：剥前缀 → 分流（SSE 直通 / 文本改写 / 二进制直通） ---------- */

  /** Proxy one request to the dashboard, following the §4.3.2 routing order. */
  function proxy(request, response) {
    const incoming = new URL(request.url ?? '/', 'http://127.0.0.1');
    let rest = incoming.pathname.slice(PREFIX.length);
    if (rest === '') rest = '/';
    const headers = { ...request.headers };
    delete headers.host;
    delete headers['accept-encoding'];      // keep bodies intact for rewriting

    const upstream = http.request({
      host: '127.0.0.1',
      port,
      method: request.method,
      path: `${rest}${incoming.search}`,
      headers,
    }, (answer) => {
      const contentType = String(answer.headers['content-type'] ?? '');
      const outHeaders = { ...answer.headers };
      for (const hop of HOP_BY_HOP) delete outHeaders[hop];
      const location = outHeaders.location;
      if (typeof location === 'string' && location.startsWith('/')) {
        outHeaders.location = `${PREFIX}${location}`;
      }

      // 上游响应流中途断连（T5-R1）：三条分支统一在这里收口。sent 标记客户端响应头
      // 是否已发出——未发头还能补一个 502 JSON；已发头（SSE/二进制已 writeHead、
      // 文本已写完）无法再改状态码，只能 destroy 客户端连接。两种处置都不让客户端
      // 挂起到超时。'aborted' 兜底上游 socket 半关闭（现代 Node 也会以 error 抛出）。
      let sent = false;
      const failClient = (error) => {
        if (response.writableEnded || response.destroyed) return;
        if (!sent) {
          const payload = Buffer.from(JSON.stringify({
            error: `情报雷达服务响应中断：${error?.message ?? '上游连接被中止'}`,
            hint: '侧边栏点「重试」重新拉起服务后再试一次',
          }), 'utf8');
          try {
            response.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(payload.length) });
            response.end(payload);
          } catch {
            response.destroy();
          }
          return;
        }
        // 已发头：掐断客户端连接（EventSource 会自动重连），并回收上游 socket
        response.destroy();
        upstream.destroy();
      };
      answer.on('error', failClient);
      answer.on('aborted', () => failClient(new Error('上游连接在响应中途被中止')));

      // ① SSE 最高优先：流式直通。不缓冲、不改写——采集事件要实时到达客户端，
      //    掉进 TEXTUAL 缓冲路径看板就「采集完了也不自动更新」（静默失效）。
      if (SSE.test(contentType)) {
        sent = true;
        response.writeHead(answer.statusCode ?? 502, outHeaders);
        answer.pipe(response);
        return;
      }

      // ② 其余文本：缓冲 + 引号前缀改写（覆盖 fetch()/EventSource/导入路径/图标）。
      if (TEXTUAL.test(contentType)) {
        const chunks = [];
        answer.on('data', (chunk) => chunks.push(chunk));
        answer.on('end', () => {
          const body = rewrite(decode(Buffer.concat(chunks), contentType));
          const buffer = Buffer.from(body, 'utf8');
          delete outHeaders['transfer-encoding'];
          outHeaders['content-length'] = String(buffer.length);
          sent = true;
          response.writeHead(answer.statusCode ?? 200, outHeaders);
          response.end(buffer);
        });
        return;
      }

      // ③ 二进制（docx 导出、图片等）：pipe 直通，保留 content-length。
      sent = true;
      response.writeHead(answer.statusCode ?? 502, outHeaders);
      answer.pipe(response);
    });

    upstream.on('error', (error) => {
      const payload = Buffer.from(JSON.stringify({
        error: `情报雷达服务不可用：${error.message}`,
        hint: '侧边栏里点「重试」会自动拉起服务，或检查端口是否被占用',
      }), 'utf8');
      response.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(payload.length) });
      response.end(payload);
    });

    request.pipe(upstream);
  }

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: PREFIX,
      handler: async (request, response) => {
        if (!(await probe())) {
          const started = await start();
          if (!started.running) {
            const payload = Buffer.from(JSON.stringify({ error: started.error ?? '情报雷达服务没起来', log: logPath }), 'utf8');
            response.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(payload.length) });
            response.end(payload);
            return;
          }
        }
        proxy(request, response);
      },
    }), 'trend-radar: proxy route');
  });

  ctx.effect(() => ctx.connection.fetch.register({
    path: ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: '请求体不是 JSON' }, 400);
      }
      try {
        return json(await run(String(body?.action ?? 'status')));
      } catch (error) {
        ctx.logger?.warn?.(`trend-radar: action failed: ${error?.message ?? error}`);
        return json({ error: error?.message ?? String(error) }, 400);
      }
    },
  }), 'trend-radar: fetch route');

  ctx.effect(() => {
    ctx.tools.register({
      name: 'trend_radar',
      description: '本地情报雷达服务管理：查看/启动/停止/重启 trend-radar 看板服务（DSH 侧边栏「情报雷达」里直接使用，无需记端口）。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ACTIONS, description: 'status=看状态，start=启动服务，stop=停止，restart=重启。' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(_args, value) {
          return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
        },
      },
      async execute(args) {
        return run(String(args?.action ?? 'status'));
      },
    });
  }, 'trend-radar: service tool');

  // 七个 trend_* 数据工具自旧工具桥（~/.dsh/local-bundles/dsh-trend-radar）原样移植：
  // 同名、同参数、同渲染文本，既有会话/脚本无感迁移；数据目录不变（~/.trend-radar）。
  ctx.effect(() => {
    ctx.tools.register({
      name: 'trend_status',
      description: '查看技术情报雷达（trend-radar）运行状态：服务健康、库内条目统计、信源列表、最近采集运行。任何 trend_* 工具前先调它确认服务（127.0.0.1:8787，未运行会自动拉起）。用户提到「趋势雷达/技术情报/trend-radar 状态」时使用。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      // 工具注册表要求 output 至少声明 render（T13：缺 render 会让整个 fiber failed 并回滚全部 effect）。
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(_args, value) {
          return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
        },
      },
      async execute() {
        try { return await toolStatus(); } catch (e) { return { error: String((e && e.message) || e) }; }
      },
    });

    ctx.tools.register({
      name: 'trend_collect',
      description: '触发一轮情报采集（arXiv / GitHub Releases / RSS，幂等，约 1–3 分钟）。可选 sourceIds 只抓指定信源。采集完成后用 trend_items 查看新条目。用户说「采一轮/抓取最新情报」时使用。',
      parameters: {
        type: 'object',
        properties: {
          sourceIds: { type: 'array', items: { type: 'string' }, description: '可选，只采集这些信源 id（trend_status 可查）' },
        },
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(_args, value) {
          return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
        },
      },
      async execute(args) {
        try { return await toolCollect(args && args.sourceIds); } catch (e) { return { error: String((e && e.message) || e) }; }
      },
    });

    ctx.tools.register({
      name: 'trend_items',
      description: '检索库内情报条目（论文/新闻/发布），支持关键词、类型、最低分、日期、排序、分页。每条带 0-100 可解释得分。用户要「看看今天的论文/最新情报/高分条目」时使用。',
      parameters: {
        type: 'object',
        properties: {
          q: { type: 'string', description: '关键词过滤' },
          kind: { type: 'string', enum: ['paper', 'news', 'release'], description: '条目类型' },
          minScore: { type: 'number', description: '最低得分 0-100' },
          since: { type: 'string', description: 'ISO 日期，如 2026-11-01' },
          sort: { type: 'string', enum: ['score', 'time'], description: '排序，默认 score' },
          limit: { type: 'number', description: '返回条数，默认 15' },
          offset: { type: 'number', description: '分页偏移' },
        },
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(_args, value) {
          const lines = [];
          if (value && value.error) lines.push('trend_items 出错：' + value.error);
          else lines.push.apply(lines, renderItems(value));
          return [{ type: 'text', text: lines.join(NL) }];
        },
      },
      async execute(args) {
        try { return await toolItems(args || {}); } catch (e) { return { error: String((e && e.message) || e) }; }
      },
    });

    ctx.tools.register({
      name: 'trend_ideas',
      description: '列出专利选题工作台的选题（含查新判读状态 draft/verified/red-ocean/archived）。要生成新选题用 trend_idea_generate，看选题全文用 trend_idea_detail。',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['draft', 'verified', 'red-ocean', 'archived'], description: '按状态过滤' },
        },
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(_args, value) {
          const lines = [];
          if (value && value.error) { lines.push('trend_ideas 出错：' + value.error); }
          else {
            const ideas = Array.isArray(value) ? value : (value && value.ideas) || [];
            lines.push('共 ' + ideas.length + ' 条选题：');
            ideas.forEach(function (idea) { lines.push.apply(lines, renderIdea(idea, false)); });
          }
          return [{ type: 'text', text: lines.join(NL) }];
        },
      },
      async execute(args) {
        try { return await toolIdeas(args && args.status); } catch (e) { return { error: String((e && e.message) || e) }; }
      },
    });

    ctx.tools.register({
      name: 'trend_idea_generate',
      description: '基于库内情报用 LLM 生成中国发明专利选题（技术问题/方案/效果/IPC/查新检索式，2–5 分钟）。需要 trend-radar 已配置 LLM（web 看板设置页或 LLM_BASE_URL/LLM_API_KEY），未配置会返回明确错误。',
      parameters: {
        type: 'object',
        properties: {
          focus: { type: 'string', description: '选题方向描述，如「投机解码与 KV 缓存压缩的交叉点」' },
          count: { type: 'number', description: '生成条数 1-20，默认 3' },
          itemIds: { type: 'array', items: { type: 'string' }, description: '可选，限定依据的情报条目 id（trend_items 可查）' },
        },
        required: ['focus'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(_args, value) {
          const lines = [];
          if (value && value.error) lines.push('trend_idea_generate 出错：' + value.error);
          else {
            const ideas = (value && value.ideas) || [];
            lines.push('生成 ' + ideas.length + ' 条选题：');
            ideas.forEach(function (idea) { lines.push.apply(lines, renderIdea(idea, true)); });
          }
          return [{ type: 'text', text: lines.join(NL) }];
        },
      },
      async execute(args) {
        try {
          if (!args || !args.focus) return { error: '缺少 focus 参数' };
          return await toolGenerate(args);
        } catch (e) { return { error: String((e && e.message) || e) }; }
      },
    });

    ctx.tools.register({
      name: 'trend_idea_detail',
      description: '查看选题详情：全文（问题/方案/效果/检索式/风险），可选触发查新判读（runNovelty，20-60s）或导出专利交底书（disclosure，Markdown 全文）。用户要「深入这条选题/查新/写交底书」时使用。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '选题 id（trend_ideas 可查）' },
          runNovelty: { type: 'boolean', description: '顺带跑一轮自动查新（红海/机会/缺口/存疑判读）' },
          disclosure: { type: 'boolean', description: '附交底书 Markdown 全文' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(_args, value) {
          const lines = [];
          if (value && value.error) { lines.push('trend_idea_detail 出错：' + value.error); }
          else if (value) {
            lines.push.apply(lines, renderIdea(value, true));
            if (value.problem && value.problem.length > 160) lines.push('问题全文：' + value.problem);
            if (value.solution && value.solution.length > 160) lines.push('方案全文：' + value.solution);
            if (value.novelty) {
              lines.push('查新：' + (value.novelty.error ? value.novelty.error : JSON.stringify(value.novelty).slice(0, 600)));
            }
            if (value.disclosure) {
              lines.push('');
              lines.push(value.disclosure.error ? ('交底书出错：' + value.disclosure.error) : ('===== 交底书 =====' + NL + (value.disclosure.raw || '').slice(0, 3000)));
            }
          }
          return [{ type: 'text', text: lines.join(NL) }];
        },
      },
      async execute(args) {
        try {
          if (!args || !args.id) return { error: '缺少 id 参数' };
          return await toolIdeaDetail(args);
        } catch (e) { return { error: String((e && e.message) || e) }; }
      },
    });

    ctx.tools.register({
      name: 'trend_watch',
      description: '检索式巡检管理：盯住一个技术方向，命中数异动即选题触发器。action=list 列出巡检项 / add 新增（query 4-80 字）/ sweep 立即同步跑一轮（调外部查新 CLI，20-60s）。用户要「盯住某方向/巡检」时使用。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'add', 'sweep'], description: '默认 list' },
          query: { type: 'string', description: 'add 时必填：检索式，如「投机解码 草稿 重建」' },
          note: { type: 'string', description: 'add 可选备注' },
          all: { type: 'boolean', description: 'list 时含禁用项' },
        },
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(_args, value) {
          const lines = [];
          if (value && value.error) { lines.push('trend_watch 出错：' + value.error); }
          else {
            const list = Array.isArray(value) ? value : (value && value.watches) || (value && value.results) || [];
            if (Array.isArray(list) && list.length) {
              list.forEach(function (w) {
                lines.push('- ' + (w.query || w.id) + (w.enabled === false ? '（已禁用）' : '') + (w.note ? ' ' + w.note : ''));
              });
            } else {
              lines.push(JSON.stringify(value).slice(0, 800));
            }
          }
          return [{ type: 'text', text: lines.join(NL) }];
        },
      },
      async execute(args) {
        try { return await toolWatch(args || {}); } catch (e) { return { error: String((e && e.message) || e) }; }
      },
    });
  }, 'trend-radar: data tools');

  ctx.logger?.info?.(`trend-radar: mount ${PREFIX} -> 127.0.0.1:${port} (repo ${repo}, data ${dataDir})`);
}
