/**
 * SSE hub：一个 app 一个实例，负责订阅/广播/断开清理与心跳。
 *
 * 为什么直接操作 `ServerResponse`：SSE 是长连接，fastify 的 reply 生命周期
 * 会在 handler 返回时结束，所以路由里 `reply.hijack()` 之后由 hub 接管 socket。
 * hub 自己维护心跳定时器（unref），保证「没有客户端时不留活句柄」，这样
 * 测试与 `close()` 都不会被定时器拖住。
 */
import type { ServerResponse } from 'node:http';

/** 25s 一次注释帧：穿过反代时防止空闲断流，也顺手探测已经死掉的 socket */
const HEARTBEAT_MS = 25_000;

export type SseEventName = 'hello' | 'run' | 'items' | 'idea' | 'bye';

const SSE_HEADERS: Record<string, string> = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  // nginx 默认会缓冲响应体，SSE 会被憋住直到连接结束
  'x-accel-buffering': 'no',
};

const frame = (event: SseEventName, data: unknown): string =>
  // JSON.stringify 会把换行转义掉，所以 data 一定单行，符合 SSE 帧格式
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export class SseHub {
  private readonly clients = new Set<ServerResponse>();
  private heartbeat: NodeJS.Timeout | undefined;
  private closed = false;

  get size(): number {
    return this.clients.size;
  }

  /** 接管一个已 hijack 的响应：写头、发 hello、登记清理 */
  add(res: ServerResponse): void {
    if (this.closed) {
      // 关闭竞态：hub 已经收摊，别再挂一个永远不会收到消息的连接
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('server is shutting down');
      return;
    }

    res.writeHead(200, SSE_HEADERS);
    this.clients.add(res);
    // 'close' 覆盖「客户端断开」和「服务端 end」两种收尾，只清一次
    res.on('close', () => this.remove(res));
    res.on('error', () => this.remove(res));

    this.send(res, 'hello', { ok: true, serverTime: new Date().toISOString() });
    this.startHeartbeat();
  }

  /** 广播给所有订阅者；返回实际送达数，方便测试与日志断言 */
  broadcast(event: SseEventName, data: unknown): number {
    let delivered = 0;
    // 快照遍历：send 过程中对端可能断开并触发 remove
    for (const res of [...this.clients]) {
      if (this.send(res, event, data)) delivered += 1;
    }
    return delivered;
  }

  /** 关闭全部连接并停心跳：优雅关闭的第一步，必须在 fastify.close() 之前做 */
  close(): void {
    this.closed = true;
    this.stopHeartbeat();
    for (const res of [...this.clients]) {
      this.send(res, 'bye', { reason: 'server_shutdown' });
      this.remove(res);
      res.end();
    }
  }

  private send(res: ServerResponse, event: SseEventName, data: unknown): boolean {
    if (res.writableEnded || res.destroyed) {
      this.remove(res);
      return false;
    }
    try {
      res.write(frame(event, data));
      return true;
    } catch {
      this.remove(res);
      return false;
    }
  }

  private remove(res: ServerResponse): void {
    this.clients.delete(res);
    if (this.clients.size === 0) this.stopHeartbeat();
  }

  private startHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      // 注释帧（以 ':' 开头）是 SSE 规定的心跳写法，客户端不会当成事件
      for (const res of [...this.clients]) this.comment(res, 'ping');
    }, HEARTBEAT_MS);
    // 定时器不该成为「进程/测试退出」的阻塞原因
    this.heartbeat.unref();
  }

  private comment(res: ServerResponse, text: string): void {
    if (res.writableEnded || res.destroyed) {
      this.remove(res);
      return;
    }
    try {
      res.write(`: ${text}\n\n`);
    } catch {
      this.remove(res);
    }
  }

  private stopHeartbeat(): void {
    if (!this.heartbeat) return;
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }
}
