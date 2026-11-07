/**
 * 对话页（#/chat）：与雷达助手对话，POST /api/chat，SSE 流式渲染。
 *
 * 结构：满高两段式 —— 消息滚动区（内部滚动）+ 底部输入区。
 * R2 起会话由后端按 sessionId 持久化：前端 crypto.randomUUID() 生成 id、
 * 随每条请求发送；done 帧带回 sessionId 后才写入 localStorage（radar.chat.sessionId），
 * 「新对话」= 换新 id + 清空消息。历史不再随请求发送（streamChat 的 history 参数保留兼容）。
 * 会话面板（Drawer）可查看 / 切换 / 删除最近 20 个会话；流式生成期间禁止切换与删除。
 *
 * 消息的四个阶段：streaming（含进度行 + 流式光标）→ done（工具徽标链）/
 * error（llm_not_configured 引导去设置；网络中断提示「连接中断」；其它可重试）/
 * interrupted（用户点了停止，保留已生成文本）。
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import {
  deleteChatSession,
  friendlyError,
  getChatSession,
  listChatSessions,
  streamChat,
  toApiError,
  type ChatSourceRef,
} from '../lib/api';
import type { ChatSessionMessage, ChatSessionSummary } from '../lib/types';
import { KIND_META } from '../lib/format';
import { renderChatMarkdown } from '../lib/md';
import type { RouteName } from '../lib/hooks';
import { Icon, type IconName } from '../components/Icon';
import { Drawer } from '../components/Overlay';
import { Kbd, Pill, Spinner } from '../components/primitives';
import { ListRowSkeleton } from '../components/Skeleton';
import { useToastFns } from '../components/Toast';
import { relTime } from '../lib/format';

// ------------------------------------------------------------------ 会话 id（localStorage）

const SESSION_KEY = 'radar.chat.sessionId';

function newSessionId(): string {
  // crypto.randomUUID 覆盖所有现代浏览器；兜底只为了在极老环境里不崩
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function readStoredSessionId(): string | null {
  try {
    return localStorage.getItem(SESSION_KEY);
  } catch {
    return null; // 隐私模式存不了：退化为纯内存会话
  }
}

function storeSessionId(id: string): void {
  try {
    localStorage.setItem(SESSION_KEY, id);
  } catch {
    // 同上：存不了就只活在本页
  }
}

function clearStoredSessionId(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    // ignore
  }
}

// ------------------------------------------------------------------ 常量

const QUICK_ASKS = [
  '今天有什么值得读的',
  '投机解码方向最近有什么新论文',
  'KV cache 压缩的专利布局怎么样',
  '基于最近高分情报生成 3 条专利选题',
];

/** 工具徽标的中文文案；未知工具直接显示原始 id（联调期可读） */
const TOOL_LABEL: Record<string, string> = {
  search: '库内检索',
  web: '公开检索',
  patent: '专利检索',
  novelty: '查新',
  idea: '选题生成',
  collect: '采集',
};

/**
 * 引用条目的类型徽标：paper / news / release 复用情报流同一套 KIND_META 色，
 * patent / idea 是对话特有类型，分别用强调色与「机会」黄绿，不新增 token。
 */
const SOURCE_KIND_META: Record<string, { label: string; color: string }> = {
  paper: KIND_META.paper,
  news: KIND_META.news,
  release: KIND_META.release,
  patent: { label: '专利', color: 'var(--color-accent)' },
  idea: { label: '选题', color: 'var(--color-lime)' },
};

// ------------------------------------------------------------------ 消息模型

type ChatPhase = 'streaming' | 'done' | 'error' | 'interrupted';

interface ChatMsg {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  phase: ChatPhase;
  /** 流式中的当前步骤（done 后清空，折叠成工具徽标链） */
  status: { step: string; label: string } | null;
  toolsUsed: string[];
  /** 已按 url 去重的引用列表 */
  sources: ChatSourceRef[];
  errorCode: string | null;
  errorText: string | null;
}

function userMsg(id: string, content: string): ChatMsg {
  return { id, role: 'user', content, phase: 'done', status: null, toolsUsed: [], sources: [], errorCode: null, errorText: null };
}

function assistantMsg(id: string): ChatMsg {
  return { id, role: 'assistant', content: '', phase: 'streaming', status: null, toolsUsed: [], sources: [], errorCode: null, errorText: null };
}

/** 引用按 url 去重（保留首次出现顺序） */
function mergeSources(prev: ChatSourceRef[], incoming: ChatSourceRef[]): ChatSourceRef[] {
  const seen = new Set(prev.map((s) => s.url));
  const out = [...prev];
  for (const s of incoming) {
    if (!s.url || seen.has(s.url)) continue;
    seen.add(s.url);
    out.push(s);
  }
  return out;
}

/** 会话详情 → 本页消息模型（phase 全部视为 done；引用去重，工具徽标原样还原） */
function toChatMsgs(sessionId: string, rows: ChatSessionMessage[]): ChatMsg[] {
  return rows.map((m, i) => {
    const sources: ChatSourceRef[] = [];
    if (Array.isArray(m.sources)) {
      for (const s of m.sources) {
        if (!s || typeof s !== 'object') continue;
        if (typeof s.url !== 'string' || s.url === '') continue;
        sources.push({
          ...(typeof s.id === 'string' ? { id: s.id } : {}),
          title: typeof s.title === 'string' && s.title !== '' ? s.title : s.url,
          url: s.url,
          ...(typeof s.kind === 'string' ? { kind: s.kind } : {}),
          ...(typeof s.score === 'number' && Number.isFinite(s.score) ? { score: s.score } : {}),
        });
      }
    }
    return {
      id: `h-${sessionId}-${i}`,
      role: m.role,
      content: m.content,
      phase: 'done',
      status: null,
      toolsUsed: Array.isArray(m.toolsUsed) ? [...m.toolsUsed] : [],
      sources: mergeSources([], sources),
      errorCode: null,
      errorText: null,
    };
  });
}

// ------------------------------------------------------------------ 子组件

function StatusLine({ label }: { label: string }): JSX.Element {
  return (
    <div className="mt-1.5 flex items-center gap-2 text-[11.5px] text-ink-2" role="status">
      <span className="glow-dot shrink-0" />
      <span>{label}</span>
    </div>
  );
}

function ToolBadges({ tools }: { tools: string[] }): JSX.Element {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <Icon name="check" size={12} className="shrink-0 text-accent" />
      {tools.map((t, i) => (
        <Pill key={`${t}-${i}`} title={`本轮使用的工具：${t}`}>
          {TOOL_LABEL[t] ?? t}
        </Pill>
      ))}
    </div>
  );
}

function SourceList({ sources }: { sources: ChatSourceRef[] }): JSX.Element | null {
  if (sources.length === 0) return null;
  return (
    <div className="mt-2.5 border-t border-line pt-2">
      <div className="eyebrow mb-1.5">引用 · {sources.length}</div>
      <ol className="space-y-1">
        {sources.map((s, i) => {
          const meta = s.kind ? SOURCE_KIND_META[s.kind] : undefined;
          return (
            <li key={`${s.url}-${i}`} className="flex min-w-0 items-baseline gap-1.5 text-[11.5px] leading-[1.6]">
              <span className="num shrink-0 text-ink-3">[{i + 1}]</span>
              <a
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                title={s.title}
                className="min-w-0 truncate text-ink-2 underline decoration-line-strong underline-offset-2 transition-colors hover:text-accent"
              >
                {s.title}
              </a>
              {meta ? (
                <Pill
                  className="shrink-0"
                  color={meta.color}
                  bg={`color-mix(in oklab, ${meta.color} 12%, transparent)`}
                  border={`color-mix(in oklab, ${meta.color} 32%, transparent)`}
                >
                  {meta.label}
                </Pill>
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function UserBubble({ msg }: { msg: ChatMsg }): JSX.Element {
  return (
    <div className="flex justify-end">
      <div
        className="max-w-[85%] rounded-xl rounded-br-sm border px-3.5 py-2.5 text-[13px] leading-[1.65] break-words whitespace-pre-wrap"
        style={{
          background: 'color-mix(in oklab, var(--color-accent) 12%, var(--color-surface))',
          borderColor: 'color-mix(in oklab, var(--color-accent) 30%, transparent)',
        }}
      >
        {msg.content}
      </div>
    </div>
  );
}

function AssistantBubble({
  msg,
  onRetry,
  onSettings,
}: {
  msg: ChatMsg;
  onRetry: (id: string) => void;
  onSettings: () => void;
}): JSX.Element {
  const offlineLike = msg.errorCode === 'network_error' || msg.errorCode === 'timeout';
  return (
    <div className="flex justify-start">
      <div className="card min-w-0 max-w-[92%] rounded-xl rounded-bl-sm px-3.5 py-2.5">
        {msg.content ? (
          // md.ts 先整体转义再解析受限语法，不存在原始 HTML 注入路径
          <div
            className={`chat-md text-[13px] leading-[1.7] break-words ${msg.phase === 'streaming' ? 'chat-md--streaming' : ''}`}
            dangerouslySetInnerHTML={{ __html: renderChatMarkdown(msg.content) }}
          />
        ) : null}

        {msg.phase === 'streaming' ? <StatusLine label={msg.status?.label ?? '正在思考…'} /> : null}

        {msg.phase === 'error' ? (
          <div
            className="mt-2 rounded-lg border px-2.5 py-2"
            style={{
              background: 'color-mix(in oklab, var(--color-warn) 8%, transparent)',
              borderColor: 'color-mix(in oklab, var(--color-warn) 30%, transparent)',
            }}
            role="alert"
          >
            <p className="text-[12px] leading-relaxed" style={{ color: 'var(--color-warn)' }}>
              {msg.errorCode === 'llm_not_configured'
                ? '雷达助手还没配置 LLM。到「设置 → LLM」里填好 baseURL / apiKey / model 并保存后，再来问我。'
                : offlineLike
                  ? '连接中断，已停止生成。'
                  : msg.errorText || '生成失败，请稍后重试。'}
            </p>
            <div className="mt-2 flex gap-2">
              {msg.errorCode === 'llm_not_configured' ? (
                <button type="button" className="btn h-7 text-[11.5px]" onClick={onSettings}>
                  <Icon name="external" size={12} />
                  去设置配置 LLM
                </button>
              ) : (
                <button type="button" className="btn h-7 text-[11.5px]" onClick={() => onRetry(msg.id)}>
                  <Icon name="refresh" size={12} />
                  重试
                </button>
              )}
            </div>
          </div>
        ) : null}

        {msg.phase === 'interrupted' ? (
          <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-ink-3">
            <Icon name="circle-slash" size={11} />
            已中断 · 保留已生成的部分
          </div>
        ) : null}

        {(msg.phase === 'done' || msg.phase === 'interrupted') && msg.toolsUsed.length > 0 ? (
          <ToolBadges tools={msg.toolsUsed} />
        ) : null}

        <SourceList sources={msg.sources} />
      </div>
    </div>
  );
}

function Chip({ label, onClick, disabled }: { label: string; onClick: () => void; disabled: boolean }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      className="chip cursor-pointer transition-colors hover:border-line-strong hover:bg-fill-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-45"
    >
      {label}
    </button>
  );
}

function EmptyIntro({ onAsk, disabled }: { onAsk: (q: string) => void; disabled: boolean }): JSX.Element {
  const caps: { icon: IconName; title: string; desc: string }[] = [
    { icon: 'search', title: '检索库内情报', desc: '在已采集的论文 / 资讯库里问答' },
    { icon: 'antenna', title: '实时查公开论文', desc: '顺着 arXiv 找最新公开工作' },
    { icon: 'shield', title: '查公开专利', desc: '看公开专利的布局与密度' },
    { icon: 'bulb', title: '生成专利选题', desc: '把高分情报变成可查新的选题' },
  ];
  return (
    <div className="flex h-full flex-col items-center justify-center px-4 py-6 text-center">
      <div
        className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl border border-line"
        style={{ background: 'var(--color-surface)', color: 'var(--color-accent)' }}
      >
        <Icon name="chat" size={22} />
      </div>
      <div className="text-[15px] font-semibold tracking-tight text-ink">雷达助手</div>
      <p className="mt-1.5 max-w-[420px] text-[12px] leading-relaxed text-ink-3">
        技术情报雷达的对话入口。四件事都可以直接开口问，回答会带引用来源：
      </p>
      <div className="mt-4 grid w-full max-w-[560px] grid-cols-1 gap-2 sm:grid-cols-2">
        {caps.map((c) => (
          <div key={c.title} className="flex items-start gap-2.5 rounded-lg border border-line bg-surface px-3 py-2.5 text-left">
            <span
              className="mt-[1px] flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
              style={{
                background: 'color-mix(in oklab, var(--color-accent) 10%, transparent)',
                color: 'var(--color-accent)',
              }}
            >
              <Icon name={c.icon} size={14} />
            </span>
            <span className="min-w-0">
              <span className="block text-[12.5px] font-medium text-ink">{c.title}</span>
              <span className="block text-[11px] leading-snug text-ink-3">{c.desc}</span>
            </span>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[11px] text-ink-3">
        生成选题约需 <span className="num text-ink-2">1–2 分钟</span>，期间可以随时点「停止」。
      </p>
      <div className="mt-4 flex max-w-[560px] flex-wrap justify-center gap-1.5">
        {QUICK_ASKS.map((q) => (
          <Chip key={q} label={q} onClick={() => onAsk(q)} disabled={disabled} />
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ 会话面板

function SessionRow({
  session,
  current,
  busy,
  disabled,
  onOpen,
  onDelete,
}: {
  session: ChatSessionSummary;
  current: boolean;
  busy: boolean;
  disabled: boolean;
  onOpen: () => void;
  onDelete: () => void;
}): JSX.Element {
  return (
    <div
      className="group flex items-center gap-2 rounded-lg border px-2.5 py-2 transition-colors"
      style={{
        borderColor: current ? 'color-mix(in oklab, var(--color-accent) 45%, transparent)' : 'var(--color-line)',
        background: current ? 'color-mix(in oklab, var(--color-accent) 8%, var(--color-surface))' : 'transparent',
      }}
    >
      <button
        type="button"
        onClick={onOpen}
        disabled={disabled || current}
        title={current ? '当前会话' : session.title}
        className="min-w-0 flex-1 text-left disabled:cursor-default"
      >
        <span className="block truncate text-[12px] text-ink">{session.title || '未命名会话'}</span>
        <span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-ink-3">
          <span className="num">{session.messageCount}</span> 条 · {relTime(session.lastAt)}
        </span>
      </button>
      {current ? (
        <Pill
          className="shrink-0"
          color="var(--color-accent)"
          bg="color-mix(in oklab, var(--color-accent) 12%, transparent)"
          border="color-mix(in oklab, var(--color-accent) 32%, transparent)"
        >
          当前
        </Pill>
      ) : null}
      <button
        type="button"
        onClick={onDelete}
        disabled={disabled || busy}
        aria-label={`删除会话：${session.title}`}
        title={disabled ? '生成中，暂不能删除' : '删除会话'}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-fill-2 hover:text-danger disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy ? <Spinner size={11} /> : <Icon name="trash" size={12} />}
      </button>
    </div>
  );
}

function SessionsDrawerBody({
  sessions,
  loading,
  currentId,
  streaming,
  deletingId,
  onOpen,
  onDelete,
}: {
  sessions: ChatSessionSummary[];
  loading: boolean;
  currentId: string | null;
  streaming: boolean;
  deletingId: string | null;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}): JSX.Element {
  return (
    <div className="p-3">
      {streaming ? (
        <p className="mb-2 text-[11px] text-warn">正在生成回复，结束后才能切换或删除会话。</p>
      ) : null}
      {loading ? (
        <div className="space-y-2">
          <ListRowSkeleton />
          <ListRowSkeleton />
          <ListRowSkeleton />
        </div>
      ) : sessions.length === 0 ? (
        <p className="px-1 py-8 text-center text-[12px] text-ink-3">
          还没有历史会话。发出第一条消息后，这里会按会话自动归档（最近 20 条）。
        </p>
      ) : (
        <div className="space-y-1.5">
          {sessions.map((s) => (
            <SessionRow
              key={s.sessionId}
              session={s}
              current={s.sessionId === currentId}
              busy={deletingId === s.sessionId}
              disabled={streaming}
              onOpen={() => onOpen(s.sessionId)}
              onDelete={() => onDelete(s.sessionId)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ 页面

export function ChatPage({ navigate }: { navigate: (name: RouteName, params?: Record<string, string>) => void }): JSX.Element {
  const toast = useToastFns();
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [showJump, setShowJump] = useState(false);

  // R2 会话：初始 id 只活在内存，首次 done 才落 localStorage
  const [sessionId, setSessionId] = useState<string>(() => readStoredSessionId() ?? newSessionId());
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [loadingSession, setLoadingSession] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const stickRef = useRef(true);
  const seqRef = useRef(0);

  const streaming = messages.some((m) => m.phase === 'streaming');
  const turnCount = messages.filter((m) => m.role === 'user').length;

  // 离开页面时中断进行中的请求
  useEffect(
    () => () => {
      abortRef.current?.abort();
      abortRef.current = null;
    },
    [],
  );

  // 输入框自动增高
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  // ---------------------------------------------------------------- 会话列表

  /** 静默刷新列表：done 后 / 打开面板前都会调；失败不打扰对话 */
  const refreshSessions = useCallback(async () => {
    try {
      const rows = await listChatSessions();
      setSessions(rows);
    } catch {
      // 列表拿不到就维持现状（可能是老后端），不弹错
    } finally {
      setSessionsLoaded(true);
      setSessionsLoading(false);
    }
  }, []);

  const openPanel = useCallback(() => {
    setPanelOpen(true);
    if (!sessionsLoaded) setSessionsLoading(true);
    void refreshSessions();
  }, [refreshSessions, sessionsLoaded]);

  /** 切换会话：流式生成期间面板里已被禁用，这里再兜一道 */
  const openSession = useCallback(
    async (id: string) => {
      if (streaming || loadingSession) return;
      setLoadingSession(true);
      try {
        const detail = await getChatSession(id);
        setMessages(toChatMsgs(id, detail.messages));
        setSessionId(id);
        sessionIdRef.current = id;
        storeSessionId(id);
        setPanelOpen(false);
        stickRef.current = true;
        setShowJump(false);
      } catch (err) {
        toast.error('会话加载失败', friendlyError(err).title);
      } finally {
        setLoadingSession(false);
      }
    },
    [loadingSession, streaming, toast],
  );

  const removeSession = useCallback(
    async (id: string) => {
      if (streaming || deletingId !== null) return;
      setDeletingId(id);
      try {
        await deleteChatSession(id);
        setSessions((prev) => prev.filter((s) => s.sessionId !== id));
        if (id === sessionIdRef.current) {
          // 删的是当前会话：就地开一个新会话（与「新对话」同一口径）
          abortRef.current?.abort();
          abortRef.current = null;
          clearStoredSessionId();
          const nextId = newSessionId();
          sessionIdRef.current = nextId;
          setSessionId(nextId);
          setMessages([]);
          stickRef.current = true;
        }
        toast.ok('会话已删除');
      } catch (err) {
        toast.error('删除失败', friendlyError(err).title);
      } finally {
        setDeletingId(null);
      }
    },
    [deletingId, sessionIdRef, streaming, toast],
  );

  // ---------------------------------------------------------------- 滚动吸附

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    stickRef.current = near;
    setShowJump(!near);
  }, []);

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    stickRef.current = true;
    setShowJump(false);
  }, []);

  // 内容变化（流式 token / 新消息）时，只有用户停在底部才吸附
  useEffect(() => {
    if (stickRef.current) scrollToBottom(false);
  }, [messages, scrollToBottom]);

  // ---------------------------------------------------------------- 发送 / 停止 / 重试

  const patchMsg = useCallback((id: string, patch: (m: ChatMsg) => ChatMsg) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? patch(m) : m)));
  }, []);

  /** 发起一轮：历史由后端按 sessionId 自取，前端不再随请求发送 */
  const runTurn = useCallback(
    (userText: string, prior: ChatMsg[]) => {
      seqRef.current += 1;
      const aid = `a-${seqRef.current}`;
      setMessages([...prior, assistantMsg(aid)]);
      stickRef.current = true;
      setShowJump(false);

      const controller = new AbortController();
      abortRef.current = controller;
      const patch = (fn: (m: ChatMsg) => ChatMsg) => patchMsg(aid, fn);

      streamChat(
        { message: userText, sessionId: sessionIdRef.current },
        {
          onStatus: (s) => patch((m) => (m.phase === 'streaming' ? { ...m, status: s } : m)),
          onSources: (items) => patch((m) => (m.phase === 'streaming' ? { ...m, sources: mergeSources(m.sources, items) } : m)),
          onToken: (t) => patch((m) => (m.phase === 'streaming' ? { ...m, content: m.content + t } : m)),
          onDone: (r) => {
            patch((m) => ({ ...m, phase: 'done', status: null, toolsUsed: r.toolsUsed }));
            // 首次持久化：优先用后端 done 帧带回的 sessionId，否则落本地生成的
            const finalId = r.sessionId ?? sessionIdRef.current;
            storeSessionId(finalId);
            if (finalId !== sessionIdRef.current) {
              sessionIdRef.current = finalId;
              setSessionId(finalId);
            }
            void refreshSessions(); // done 后静默刷新会话列表
          },
          onError: (e) =>
            patch((m) =>
              m.phase === 'streaming'
                ? { ...m, phase: 'error', status: null, errorCode: e.code, errorText: e.message }
                : m,
            ),
        },
        controller.signal,
      )
        .catch((err: unknown) => {
          const apiErr = toApiError(err);
          patch((m) =>
            m.phase === 'streaming'
              ? {
                  ...m,
                  phase: 'error',
                  status: null,
                  errorCode: controller.signal.aborted ? 'interrupted' : apiErr.code,
                  errorText: apiErr.message,
                }
              : m,
          );
        })
        .finally(() => {
          if (abortRef.current === controller) abortRef.current = null;
        });
    },
    [patchMsg, refreshSessions],
  );

  const send = useCallback(
    (raw?: string) => {
      const text = (raw ?? input).trim();
      if (!text || streaming) return;
      seqRef.current += 1;
      const prior = [...messages, userMsg(`u-${seqRef.current}`, text)];
      setInput('');
      runTurn(text, prior);
    },
    [input, messages, runTurn, streaming],
  );

  const stop = useCallback(() => {
    const controller = abortRef.current;
    if (!controller) return;
    controller.abort();
    // 已收到的文本保留，就地标注「已中断」
    setMessages((prev) => prev.map((m) => (m.phase === 'streaming' ? { ...m, phase: 'interrupted', status: null } : m)));
  }, []);

  const retry = useCallback(
    (msgId: string) => {
      const idx = messages.findIndex((m) => m.id === msgId);
      if (idx <= 0) return;
      const user = messages[idx - 1];
      if (!user || user.role !== 'user') return;
      runTurn(user.content, messages.slice(0, idx));
    },
    [messages, runTurn],
  );

  /** 新对话：换新 id + 清空 localStorage 会话 id + 清空消息列表 */
  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    clearStoredSessionId();
    const nextId = newSessionId();
    sessionIdRef.current = nextId;
    setSessionId(nextId);
    setMessages([]);
    setInput('');
    setShowJump(false);
    stickRef.current = true;
  }, []);

  // ---------------------------------------------------------------- 输入

  const onTextareaKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    if (e.nativeEvent.isComposing) return; // 中文输入法选词回车不发送
    e.preventDefault();
    send();
  };

  // ---------------------------------------------------------------- 渲染

  return (
    <div className="mx-auto flex h-[calc(100dvh-108px)] min-h-[360px] w-full max-w-[860px] flex-col px-3 pt-3 md:h-[calc(100dvh-52px)] md:px-5">
      {/* 会话工具条 */}
      <div className="flex items-center gap-2 pb-2">
        <span className="text-[10.5px] text-ink-3">
          {turnCount > 0 ? (
            <>
              本会话 <span className="num text-ink-2">{turnCount}</span> 轮 · 自动按会话保存
            </>
          ) : (
            '与雷达助手对话 · 回答带引用来源'
          )}
        </span>
        <button
          type="button"
          onClick={openPanel}
          className="btn btn-ghost ml-auto h-7 gap-1 px-2 text-[11.5px]"
          title="历史会话（最近 20 条）"
        >
          <Icon name="table" size={12} />
          会话
          {sessions.length > 0 ? (
            <span className="num rounded bg-accent/15 px-1 text-[10px] text-accent">{sessions.length}</span>
          ) : null}
        </button>
        <button
          type="button"
          onClick={reset}
          disabled={messages.length === 0}
          className="btn btn-ghost h-7 px-2 text-[11.5px]"
          title="清空当前会话，开始新对话"
        >
          <Icon name="plus" size={12} />
          新对话
        </button>
      </div>

      {/* 消息滚动区 */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="scroll-area relative min-h-0 flex-1 overflow-y-auto pr-0.5"
        role="log"
        aria-label="对话消息"
        aria-live="polite"
      >
        {messages.length === 0 ? (
          <EmptyIntro onAsk={send} disabled={streaming} />
        ) : (
          <div className="space-y-3 pb-1">
            {messages.map((m) =>
              m.role === 'user' ? <UserBubble key={m.id} msg={m} /> : <AssistantBubble key={m.id} msg={m} onRetry={retry} onSettings={() => navigate('settings')} />,
            )}
          </div>
        )}

        {showJump ? (
          <button
            type="button"
            onClick={() => scrollToBottom(true)}
            className="btn sticky bottom-2 left-1/2 mx-auto flex h-7 w-fit px-2.5 text-[11px] shadow-[var(--shadow-lift)]"
          >
            <Icon name="chevron-down" size={12} />
            回到底部
          </button>
        ) : null}
      </div>

      {/* 输入区 */}
      <div className="pt-2 pb-1 md:pb-3">
        <div className="flex flex-wrap gap-1.5">
          {QUICK_ASKS.map((q) => (
            <Chip key={q} label={q} onClick={() => send(q)} disabled={streaming} />
          ))}
        </div>

        <div
          className="mt-2 flex items-end gap-2 rounded-xl border border-line bg-sunken p-2 transition-colors focus-within:border-[color-mix(in_oklab,var(--color-accent)_55%,transparent)]"
        >
          <textarea
            ref={taRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onTextareaKeyDown}
            rows={1}
            placeholder={streaming ? '生成中…（可继续输入，这轮结束后发送）' : '问雷达助手：今天有什么值得读的？'}
            aria-label="输入消息"
            className="max-h-[160px] min-h-[24px] w-full resize-none bg-transparent text-[13px] leading-[1.6] outline-none"
          />
          {streaming ? (
            <button type="button" className="btn btn-danger h-8 shrink-0 px-2.5" onClick={stop} title="停止生成（已收到的内容会保留）">
              <Icon name="x" size={13} />
              停止
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-accent h-8 shrink-0 px-2.5"
              onClick={() => send()}
              disabled={input.trim() === ''}
              title="发送（Enter）"
            >
              发送
              <Icon name="arrow-right" size={13} />
            </button>
          )}
        </div>

        <div className="mt-1 flex items-center gap-2 text-[10px] text-ink-3/85">
          <span>
            <Kbd>Enter</Kbd> 发送 · <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> 换行
          </span>
          {streaming ? (
            <span className="ml-auto inline-flex items-center gap-1 text-accent">
              <Spinner size={11} />
              生成中…
            </span>
          ) : null}
        </div>
      </div>

      {/* 会话面板：查看 / 切换 / 删除（流式生成期间禁用切换与删除） */}
      <Drawer open={panelOpen} onClose={() => setPanelOpen(false)} label="历史会话" width={330}>
        <SessionsDrawerBody
          sessions={sessions}
          loading={loadingSession || (sessionsLoading && sessions.length === 0)}
          currentId={sessionId}
          streaming={streaming}
          deletingId={deletingId}
          onOpen={(id) => void openSession(id)}
          onDelete={(id) => void removeSession(id)}
        />
      </Drawer>
    </div>
  );
}
