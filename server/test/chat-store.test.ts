import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openChatStore, type ChatStore } from '../src/store/chat-store.js';

/**
 * chat 持久化层测试（:memory: + 文件库两种形态，全程离线）。
 * 覆盖：消息追加/取历史（最近 N 条、时间正序）/会话列表摘要/删除/覆盖写权利要求。
 */

const makeStore = (): ChatStore => openChatStore(':memory:');

describe('chat-store（:memory:）', () => {
  it('appendMessage/history：取最近 N 条且时间正序，直接能当对话 history 用', () => {
    const store = makeStore();
    try {
      store.appendMessage({ sessionId: 'session-aaaaaaaa', role: 'user', content: '第一条' });
      store.appendMessage({ sessionId: 'session-aaaaaaaa', role: 'assistant', content: '第一条回答' });
      store.appendMessage({ sessionId: 'session-aaaaaaaa', role: 'user', content: '第二条' });

      expect(store.history('session-aaaaaaaa')).toEqual([
        { role: 'user', content: '第一条' },
        { role: 'assistant', content: '第一条回答' },
        { role: 'user', content: '第二条' },
      ]);
      // limit=2 → 最近两条，仍正序
      expect(store.history('session-aaaaaaaa', 2)).toEqual([
        { role: 'assistant', content: '第一条回答' },
        { role: 'user', content: '第二条' },
      ]);
      // 其他会话隔离
      expect(store.history('session-bbbbbbbb')).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('appendMessage 保存 toolsUsed/sources；session 明细带元数据、空元数据不出现在响应里', () => {
    const store = makeStore();
    try {
      store.appendMessage({ sessionId: 'session-aaaaaaaa', role: 'user', content: '查一下' });
      store.appendMessage({
        sessionId: 'session-aaaaaaaa',
        role: 'assistant',
        content: '结论',
        toolsUsed: ['search_local', 'draft_claims'],
        sources: [{ title: 'T', url: 'https://x', kind: 'paper', meta: { score: 1 } }],
      });

      const detail = store.session('session-aaaaaaaa');
      expect(detail?.sessionId).toBe('session-aaaaaaaa');
      expect(detail?.messages).toHaveLength(2);
      expect(detail?.messages[0]).toEqual({ role: 'user', content: '查一下', at: expect.any(String) });
      expect(detail?.messages[1]).toMatchObject({
        role: 'assistant',
        content: '结论',
        toolsUsed: ['search_local', 'draft_claims'],
        sources: [{ title: 'T', kind: 'paper' }],
      });
    } finally {
      store.close();
    }
  });

  it('sessions：标题取首条用户消息 ≤40 字，按最近活跃倒序，计数正确', () => {
    const store = makeStore();
    try {
      const longTitle = `首条`.repeat(30); // 60 个字 → 截到 40
      store.appendMessage({ sessionId: 'session-old', role: 'user', content: longTitle, at: '2026-11-01T08:00:00.000Z' });
      store.appendMessage({ sessionId: 'session-old', role: 'assistant', content: '答', at: '2026-11-01T08:01:00.000Z' });
      store.appendMessage({ sessionId: 'session-new', role: 'user', content: '短问题', at: '2026-11-05T09:00:00.000Z' });

      const sessions = store.sessions();
      expect(sessions.map((session) => session.sessionId)).toEqual(['session-new', 'session-old']);
      expect(sessions[0]).toMatchObject({ title: '短问题', messageCount: 1, lastAt: '2026-11-05T09:00:00.000Z' });
      expect([...sessions[1]!.title].length).toBe(40);
      expect(sessions[1]).toMatchObject({ messageCount: 2 });
      // limit 生效
      expect(store.sessions(1)).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it('removeSession 删除整个会话；session 不存在返回 false', () => {
    const store = makeStore();
    try {
      store.appendMessage({ sessionId: 'session-aaaaaaaa', role: 'user', content: 'x' });
      expect(store.removeSession('session-aaaaaaaa')).toBe(true);
      expect(store.session('session-aaaaaaaa')).toBeUndefined();
      expect(store.removeSession('session-aaaaaaaa')).toBe(false);
    } finally {
      store.close();
    }
  });

  it('idea_claims：saveClaims 覆盖写（INSERT OR REPLACE），getClaims 取回', () => {
    const store = makeStore();
    try {
      expect(store.getClaims('idea-1')).toBeUndefined();
      store.saveClaims('idea-1', '1. 一种方法…');
      expect(store.getClaims('idea-1')).toMatchObject({ content: '1. 一种方法…', at: expect.any(String) });
      store.saveClaims('idea-1', '1. 一种改进的方法…', '2026-11-05T00:00:00.000Z');
      expect(store.getClaims('idea-1')).toEqual({ content: '1. 一种改进的方法…', at: '2026-11-05T00:00:00.000Z' });
    } finally {
      store.close();
    }
  });
});

describe('chat-store（文件库）', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'trend-radar-chatstore-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('同 dataDir 连接复用：两个句柄看到同一份数据，close 后重开数据还在', () => {
    const first = openChatStore(dataDir);
    const second = openChatStore(dataDir);
    first.appendMessage({ sessionId: 'session-aaaaaaaa', role: 'user', content: '持久化' });
    expect(second.session('session-aaaaaaaa')?.messages).toHaveLength(1);

    first.close();
    second.close();

    const reopened = openChatStore(dataDir);
    expect(reopened.history('session-aaaaaaaa')).toEqual([{ role: 'user', content: '持久化' }]);
    reopened.close();
  });
});
