/**
 * chat 会话与权利要求草案的持久化。为什么这么设计：
 *
 * 1. **自持 DatabaseSync，绝不走 db.ts 的连接**：chat 会话是「可选能力」，不该
 *    让主连接的生命周期跟它绑死；独立连接 + WAL（主库已开 WAL）下多连接读写
 *    互不阻塞，busy_timeout 兜住极端并发。同样刻意**不进 db.ts 的 user_version
 *    迁移链**——那只属于存储层独占，这里与 settings/watches 一样用
 *    `CREATE TABLE IF NOT EXISTS` 自建表，任何老库/新库/并发启动都幂等安全。
 * 2. **连接按 dataDir 复用**：同进程同库只开一个连接（:memory: 除外——每次
 *    open 都是独立内存库，正好给测试天然隔离）。
 * 3. **无 sessionId 的旧模式完全不落库**：R1 的行为是默认路径，持久化只在
 *    请求显式带 sessionId 时发生，升级零迁移。
 */
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

export interface ChatStoredSource {
  title: string;
  url: string;
  kind: string;
  meta: Record<string, unknown>;
}

export interface ChatStoredMessage {
  id: number;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  toolsUsed: string[];
  sources: ChatStoredSource[];
  at: string;
}

export interface ChatSessionSummary {
  sessionId: string;
  /** 首条用户消息（≤40 字），会话列表的展示标题 */
  title: string;
  lastAt: string;
  messageCount: number;
}

export interface ChatSessionDetail {
  sessionId: string;
  messages: {
    role: 'user' | 'assistant';
    content: string;
    toolsUsed?: string[];
    sources?: ChatStoredSource[];
    at: string;
  }[];
}

export interface ChatStore {
  appendMessage(input: {
    sessionId: string;
    role: 'user' | 'assistant';
    content: string;
    toolsUsed?: string[];
    sources?: ChatStoredSource[];
    at?: string;
  }): void;
  /** 最近 limit 条（默认 12），按时间正序返回——直接当 runChat 的 history 用 */
  history(sessionId: string, limit?: number): { role: 'user' | 'assistant'; content: string }[];
  /** 会话消息明细，上限 limit（默认 200），按时间正序 */
  session(sessionId: string, limit?: number): ChatSessionDetail | undefined;
  /** 会话列表（按最近活跃倒序，默认 20） */
  sessions(limit?: number): ChatSessionSummary[];
  removeSession(sessionId: string): boolean;
  /** 权利要求草案：同一条选题重复起草即覆盖（INSERT OR REPLACE 语义） */
  saveClaims(ideaId: string, content: string, at?: string): void;
  getClaims(ideaId: string): { content: string; at: string } | undefined;
  close(): void;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS chat_messages (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id   TEXT NOT NULL,
    role         TEXT NOT NULL,
    content      TEXT NOT NULL,
    tools_used   TEXT,
    sources_json TEXT,
    at           TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages (session_id, at);
  CREATE TABLE IF NOT EXISTS idea_claims (
    idea_id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    at      TEXT NOT NULL
  );
`;

interface MessageRow {
  id: number | bigint;
  session_id: string;
  role: string;
  content: string;
  tools_used: string | null;
  sources_json: string | null;
  at: string;
}

/** JSON 列解析失败退回空数组：单行坏数据不该让整段会话读不出来 */
function jsonArray<T>(value: string | null): T[] {
  if (value === null || value === '') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

const toMessage = (row: MessageRow): ChatStoredMessage => ({
  id: Number(row.id),
  sessionId: row.session_id,
  role: row.role === 'assistant' ? 'assistant' : 'user',
  content: row.content,
  toolsUsed: jsonArray<string>(row.tools_used),
  sources: jsonArray<ChatStoredSource>(row.sources_json),
  at: row.at,
});

// 文件库连接复用：同 dataDir 只开一个连接（:memory: 不复用，见文件头注释 2）
const connections = new Map<string, DatabaseSync>();

/**
 * 打开（或复用）chat 存储连接。`dataDir` 与主库一致：目录时指向同库文件
 * trend-radar.db（WAL 多连接安全），`:memory:` 走独立内存库。
 */
export function openChatStore(dataDir: string): ChatStore {
  const isMemory = dataDir === ':memory:';
  const cacheKey = isMemory ? null : dataDir;
  const cached = cacheKey ? connections.get(cacheKey) : undefined;
  const db = cached ?? new DatabaseSync(isMemory ? ':memory:' : join(dataDir, 'trend-radar.db'));
  if (cacheKey) connections.set(cacheKey, db);

  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);

  const insertMessage = db.prepare(
    `INSERT INTO chat_messages (session_id, role, content, tools_used, sources_json, at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  const store: ChatStore = {
    appendMessage(input) {
      insertMessage.run(
        input.sessionId,
        input.role,
        input.content,
        input.toolsUsed && input.toolsUsed.length > 0 ? JSON.stringify(input.toolsUsed) : null,
        input.sources && input.sources.length > 0 ? JSON.stringify(input.sources) : null,
        input.at ?? new Date().toISOString(),
      );
    },

    history(sessionId, limit = 12) {
      // 倒序取最近 N 条再反转：SQL 侧拿「最近」，返回侧保持时间正序
      const rows = db
        .prepare('SELECT * FROM chat_messages WHERE session_id = ? ORDER BY at DESC, id DESC LIMIT ?')
        .all(sessionId, Math.max(1, limit)) as unknown as MessageRow[];
      return rows
        .map(toMessage)
        .reverse()
        .map((message) => ({ role: message.role, content: message.content }));
    },

    session(sessionId, limit = 200) {
      const rows = db
        .prepare('SELECT * FROM chat_messages WHERE session_id = ? ORDER BY at ASC, id ASC LIMIT ?')
        .all(sessionId, Math.max(1, limit)) as unknown as MessageRow[];
      if (rows.length === 0) return undefined;
      return {
        sessionId,
        messages: rows.map(toMessage).map((message) => ({
          role: message.role,
          content: message.content,
          ...(message.toolsUsed.length > 0 ? { toolsUsed: message.toolsUsed } : {}),
          ...(message.sources.length > 0 ? { sources: message.sources } : {}),
          at: message.at,
        })),
      };
    },

    sessions(limit = 20) {
      const rows = db
        .prepare(
          `SELECT m.session_id AS session_id,
                  COUNT(*) AS message_count,
                  MAX(m.at) AS last_at,
                  (SELECT content FROM chat_messages m2
                    WHERE m2.session_id = m.session_id AND m2.role = 'user'
                    ORDER BY m2.at ASC, m2.id ASC LIMIT 1) AS title
           FROM chat_messages m
           GROUP BY m.session_id
           ORDER BY last_at DESC
           LIMIT ?`,
        )
        .all(Math.max(1, limit)) as unknown as { session_id: string; message_count: number | bigint; last_at: string; title: string | null }[];
      return rows.map((row) => ({
        sessionId: row.session_id,
        // 首条用户消息做标题，≤40 字（按码点截，中文不会被截半）
        title: [...(row.title ?? '').trim()].slice(0, 40).join(''),
        lastAt: row.last_at,
        messageCount: Number(row.message_count),
      }));
    },

    removeSession(sessionId) {
      const result = db.prepare('DELETE FROM chat_messages WHERE session_id = ?').run(sessionId);
      return Number(result.changes ?? 0) > 0;
    },

    saveClaims(ideaId, content, at) {
      db.prepare(
        `INSERT INTO idea_claims (idea_id, content, at) VALUES (?, ?, ?)
         ON CONFLICT(idea_id) DO UPDATE SET content = excluded.content, at = excluded.at`,
      ).run(ideaId, content, at ?? new Date().toISOString());
    },

    getClaims(ideaId) {
      const row = db.prepare('SELECT content, at FROM idea_claims WHERE idea_id = ?').get(ideaId) as
        | { content: string; at: string }
        | undefined;
      return row ? { content: row.content, at: row.at } : undefined;
    },

    close() {
      if (cacheKey && connections.get(cacheKey) === db) connections.delete(cacheKey);
      try {
        db.close();
      } catch {
        // 关库失败不该让进程退出路径中断
      }
    },
  };

  return store;
}
