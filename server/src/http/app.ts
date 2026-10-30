/**
 * Fastify 组装 + 进程生命周期。
 *
 * 分工：
 *  - `buildApp(config)` 只负责「组装一个可 inject 的 app」，不监听端口、不起定时器，
 *    所以测试可以完全离网跑；
 *  - `startServer(config)` 负责 listen、定时采集、信号处理与优雅关闭。
 *
 * index.ts 的 CLI 契约是 `await startServer(config)`，签名保持不变。
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { AppConfig } from '../config.js';
import { loadDeps, type HttpDeps } from './deps.js';
import { toApiError } from './errors.js';
import { createCollector, registerRoutes, type CollectorFn } from './routes.js';
import { startScheduler, type Scheduler } from '../scheduler.js';
import { SseHub } from './sse.js';

/** 与 package.json 同号；rootDir 限制不能直接 import 仓库根的 package.json */
export const SERVER_VERSION = '0.1.0';

/** server/src/http/ → ../../../web/dist */
const DEFAULT_DIST_DIR = fileURLToPath(new URL('../../../web/dist', import.meta.url));

export interface BuildAppOptions {
  /** 注入下层实现（测试用）；不传则动态加载真实模块，并在 onClose 时自己关库 */
  deps?: HttpDeps;
  logger?: FastifyServerOptions['logger'];
  logLevel?: string;
  /** 静态目录；null = 不注册静态托管；缺省 = 仓库里的 web/dist */
  distDir?: string | null;
  /**
   * 调度器工厂：`startServer` 用它把定时采集接上，并把实例交回路由
   * （PUT /api/settings 保存后要立即 reschedule）。`buildApp` 不传 = 不装定时器。
   */
  schedulerFactory?: (input: {
    app: FastifyInstance;
    config: AppConfig;
    deps: HttpDeps;
    collect: CollectorFn;
  }) => Scheduler | undefined;
}

const requireFromHere = createRequire(import.meta.url);

const hasPinoPretty = (): boolean => {
  try {
    requireFromHere.resolve('pino-pretty');
    return true;
  } catch {
    // pino-pretty 是可选的 dev 依赖，缺了就退回 JSON 日志，不能让服务起不来
    return false;
  }
};

function resolveLogger(options: BuildAppOptions): FastifyServerOptions['logger'] {
  if (options.logger !== undefined) return options.logger;
  const level = options.logLevel ?? process.env.LOG_LEVEL ?? 'info';
  if (process.env.NODE_ENV === 'production' || !hasPinoPretty()) return { level };
  return {
    level,
    transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' } },
  };
}

interface AppBundle {
  app: FastifyInstance;
  hub: SseHub;
  collect: CollectorFn;
  scheduler: Scheduler | undefined;
}

async function createApp(config: AppConfig, options: BuildAppOptions): Promise<AppBundle> {
  const ownsDeps = options.deps === undefined;
  const deps = options.deps ?? (await loadDeps(config));
  const hub = new SseHub();

  const app = Fastify({
    logger: resolveLogger(options),
    // 没有它，SSE 之类的长连接会把 close() 永远吊住
    forceCloseConnections: true,
  });

  // 本地看板无鉴权，前端可能来自 5273（vite dev）或 8787（生产同源），反射 origin 最省事
  await app.register(cors, { origin: true, methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'] });

  const distDir = options.distDir === undefined ? DEFAULT_DIST_DIR : options.distDir;
  const staticEnabled = distDir !== null && existsSync(join(distDir, 'index.html'));
  if (staticEnabled && distDir !== null) {
    // wildcard 必须为 true：`wildcard:false` 只会注册 `/` 一条路由，`/assets/x.js`
    // 会落进下面的 notFoundHandler 被回成 index.html —— 浏览器拿 text/html 当模块脚本
    // 解析，直接白屏且**没有任何报错**（踩过）。SPA 深链回落仍由 notFoundHandler 负责。
    await app.register(fastifyStatic, { root: distDir, wildcard: true, index: 'index.html' });
  } else if (distDir !== null) {
    app.log.warn({ distDir }, 'web/dist 未构建，跳过静态托管，只提供 /api');
  }

  app.setErrorHandler((error, request, reply) => {
    const { statusCode, body } = toApiError(error);
    if (statusCode >= 500) request.log.error({ err: error }, '请求处理失败');
    else request.log.debug({ err: error, code: body.error.code }, '请求被拒绝');
    void reply.code(statusCode).send(body);
  });

  app.setNotFoundHandler((request, reply) => {
    const pathname = (request.raw.url ?? '').split('?')[0] ?? '';
    const notFoundBody = { error: { code: 'not_found', message: `路由不存在：${request.method} ${pathname}` } };
    // /api 永远返回 JSON：前端靠 code 判断，不能喂它一个 index.html
    if (pathname.startsWith('/api') || !staticEnabled) return reply.code(404).send(notFoundBody);
    if (request.method !== 'GET' && request.method !== 'HEAD') return reply.code(404).send(notFoundBody);
    // 带扩展名的路径视为静态资源：真的不存在就 404，别拿 index.html 冒充 js/css/图片
    if (/\.[a-zA-Z0-9]{1,8}$/.test(pathname)) return reply.code(404).send(notFoundBody);
    return reply.sendFile('index.html');
  });

  const collect = createCollector(config, deps, hub);
  const scheduler = options.schedulerFactory?.({ app, config, deps, collect });
  registerRoutes(app, {
    config,
    deps,
    hub,
    collect,
    scheduler,
    version: SERVER_VERSION,
    startedAt: Date.now(),
  });

  app.addHook('onClose', async () => {
    app.log.debug({ sseClients: hub.size }, '关闭 SSE 订阅');
    // 先停调度：否则关库之后定时器还可能醒来跑一轮采集
    scheduler?.stop();
    hub.close();
    if (ownsDeps) deps.close();
  });

  return { app, hub, collect, scheduler };
}

export async function buildApp(config: AppConfig, options: BuildAppOptions = {}): Promise<FastifyInstance> {
  return (await createApp(config, options)).app;
}

export interface ServerHandle {
  app: FastifyInstance;
  /** 实际监听地址，例如 http://127.0.0.1:8787 */
  url: string;
  close(): Promise<void>;
}

export async function startServer(config: AppConfig, options: BuildAppOptions = {}): Promise<ServerHandle> {
  type FactoryInput = Parameters<NonNullable<BuildAppOptions['schedulerFactory']>>[0];
  const schedulerFactory =
    options.schedulerFactory ??
    ((input: FactoryInput) =>
      startScheduler({
        config: input.config,
        settings: input.deps.getSettings(),
        run: () => input.collect(),
        // 定时采集失败只记日志：一次网络抖动不该带走常驻进程
        onError: (error: unknown) => input.app.log.error({ err: error }, '定时采集失败'),
      }));

  // 设置页里保存后要「立即生效」，所以调度器必须在组装阶段就接进路由
  const { app, scheduler } = await createApp(config, { ...options, schedulerFactory });

  const url = await app.listen({ port: config.port, host: config.host });
  app.log.info(
    {
      url,
      dataDir: config.dataDir,
      nextRefreshAt: scheduler?.nextAt()?.toISOString() ?? null,
    },
    'trend-radar API 已启动',
  );

  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    if (closing) return closing;
    closing = (async () => {
      removeSignalHandlers();
      // app.close() 的 onClose 会 stop() 调度器、关 SSE、关 sqlite
      await app.close();
    })();
    return closing;
  };

  const onSignal = (signal: NodeJS.Signals): void => {
    app.log.info({ signal }, '收到退出信号，开始优雅关闭');
    void close()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        app.log.error({ err: error }, '优雅关闭失败');
        process.exit(1);
      });
  };
  function removeSignalHandlers(): void {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }

  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  return { app, url, close };
}
