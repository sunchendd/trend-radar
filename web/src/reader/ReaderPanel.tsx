/**
 * 阅读器右侧面板：两个 Tab。
 * - 标注：高亮/笔记列表，点条目跳页，就地编辑笔记、换色、删除；
 * - 提问：选中文本的流式问答（SSE），带当前页/选区上下文与会话历史。
 */
import { useEffect, useRef, type JSX } from 'react';
import type { Item } from '../lib/types';
import { ANNOTATION_COLORS, type AnnotationColor, type PaperAnnotation, type PaperAskContext, type PaperAskMessage } from '../lib/paper';
import { Icon } from '../components/Icon';

export type ReaderTab = 'annotations' | 'ask';

export function ReaderPanel({
  item,
  tab,
  onTabChange,
  annotations,
  activeAnnotationId,
  editingNoteId,
  onJumpToAnnotation,
  onStartEditNote,
  onSaveNote,
  onColorChange,
  onDelete,
  askMessages,
  askStreaming,
  askError,
  askInput,
  askContext,
  onAskInput,
  onAskSend,
  onAskStop,
  onClearAskContext,
  askInputRef,
}: {
  item: Item;
  tab: ReaderTab;
  onTabChange: (tab: ReaderTab) => void;
  annotations: PaperAnnotation[];
  activeAnnotationId?: string;
  editingNoteId: string | null;
  onJumpToAnnotation: (a: PaperAnnotation) => void;
  onStartEditNote: (id: string | null) => void;
  onSaveNote: (a: PaperAnnotation, note: string) => void;
  onColorChange: (a: PaperAnnotation, color: AnnotationColor) => void;
  onDelete: (a: PaperAnnotation) => void;
  askMessages: PaperAskMessage[];
  askStreaming: boolean;
  askError: string;
  askInput: string;
  askContext: PaperAskContext | null;
  onAskInput: (v: string) => void;
  onAskSend: () => void;
  onAskStop: () => void;
  onClearAskContext: () => void;
  askInputRef: React.RefObject<HTMLTextAreaElement | null>;
}): JSX.Element {
  return (
    <aside className="flex w-[320px] shrink-0 flex-col border-l border-line bg-surface" aria-label="阅读器侧栏">
      <div className="flex shrink-0 border-b border-line" role="tablist" aria-label="阅读器面板">
        <TabButton active={tab === 'annotations'} onClick={() => onTabChange('annotations')} label="标注" badge={annotations.length} />
        <TabButton active={tab === 'ask'} onClick={() => onTabChange('ask')} label="提问" />
      </div>

      {tab === 'annotations' ? (
        <AnnotationList
          annotations={annotations}
          activeAnnotationId={activeAnnotationId}
          editingNoteId={editingNoteId}
          onJumpToAnnotation={onJumpToAnnotation}
          onStartEditNote={onStartEditNote}
          onSaveNote={onSaveNote}
          onColorChange={onColorChange}
          onDelete={onDelete}
        />
      ) : (
        <AskPane
          item={item}
          messages={askMessages}
          streaming={askStreaming}
          error={askError}
          input={askInput}
          context={askContext}
          onInput={onAskInput}
          onSend={onAskSend}
          onStop={onAskStop}
          onClearContext={onClearAskContext}
          inputRef={askInputRef}
        />
      )}
    </aside>
  );
}

function TabButton({ active, onClick, label, badge }: { active: boolean; onClick: () => void; label: string; badge?: number }): JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`relative flex-1 px-3 py-2.5 text-[12.5px] transition-colors ${
        active ? 'font-medium text-accent' : 'text-ink-3 hover:text-ink-2'
      }`}
    >
      {label}
      {badge !== undefined && badge > 0 ? <span className="num ml-1 text-[10.5px] text-ink-3">{badge}</span> : null}
      {active ? <span className="absolute inset-x-4 bottom-0 h-[2px] rounded-full bg-accent" /> : null}
    </button>
  );
}

function AnnotationList({
  annotations,
  activeAnnotationId,
  editingNoteId,
  onJumpToAnnotation,
  onStartEditNote,
  onSaveNote,
  onColorChange,
  onDelete,
}: {
  annotations: PaperAnnotation[];
  activeAnnotationId?: string;
  editingNoteId: string | null;
  onJumpToAnnotation: (a: PaperAnnotation) => void;
  onStartEditNote: (id: string | null) => void;
  onSaveNote: (a: PaperAnnotation, note: string) => void;
  onColorChange: (a: PaperAnnotation, color: AnnotationColor) => void;
  onDelete: (a: PaperAnnotation) => void;
}): JSX.Element {
  const draftRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editingNoteId !== null) draftRef.current?.focus();
  }, [editingNoteId]);

  if (annotations.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <Icon name="pen" size={18} className="text-ink-3" />
        <p className="text-[12px] leading-relaxed text-ink-3">
          选中论文正文即可高亮或写笔记。
          <br />
          标注会自动保存在本地库里。
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
      <ul className="space-y-2">
        {annotations.map((a) => {
          const editing = a.id === editingNoteId;
          return (
            <li
              key={a.id}
              className={`group rounded-tile border bg-raised px-2.5 py-2 transition-colors ${
                a.id === activeAnnotationId ? 'border-accent/50' : 'border-line hover:border-line-strong'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => onJumpToAnnotation(a)}
                  className="flex min-w-0 items-center gap-1.5 text-[10.5px] text-ink-3 hover:text-accent"
                  title="跳到这一页"
                >
                  <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ backgroundColor: a.color }} />
                  <span className="num">第 {a.page} 页</span>
                </button>
                <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                  {ANNOTATION_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      title="换高亮色"
                      onClick={() => onColorChange(a, c)}
                      className="h-3 w-3 rounded-full border border-line-strong transition-transform hover:scale-110"
                      style={{ backgroundColor: c }}
                    />
                  ))}
                  <button
                    type="button"
                    title="删除标注"
                    onClick={() => onDelete(a)}
                    className="ml-1 rounded p-0.5 text-ink-3 transition-colors hover:text-danger"
                  >
                    <Icon name="trash" size={12} />
                  </button>
                </div>
              </div>

              <button
                type="button"
                onClick={() => onJumpToAnnotation(a)}
                className="mt-1.5 block w-full text-left text-[11.5px] leading-relaxed text-ink-2 clamp-3"
              >
                {a.text || '（无文本选区）'}
              </button>

              {editing ? (
                <div className="mt-1.5">
                  <textarea
                    ref={draftRef}
                    defaultValue={a.note}
                    placeholder="写点笔记…（想法 / 与选题的关联 / 待查证）"
                    className="input min-h-[64px] w-full resize-y text-[11.5px]"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        onSaveNote(a, (e.target as HTMLTextAreaElement).value);
                      }
                    }}
                  />
                  <div className="mt-1 flex items-center justify-end gap-1.5">
                    <button type="button" className="btn px-2 py-1 text-[11px]" onClick={() => onStartEditNote(null)}>
                      取消
                    </button>
                    <button
                      type="button"
                      className="btn btn-accent px-2 py-1 text-[11px]"
                      onClick={() => onSaveNote(a, draftRef.current?.value ?? a.note)}
                    >
                      保存
                    </button>
                  </div>
                </div>
              ) : a.note !== '' ? (
                <p className="mt-1.5 whitespace-pre-wrap border-l-2 border-line-strong pl-2 text-[11px] leading-relaxed text-ink-2">
                  {a.note}
                </p>
              ) : (
                <button
                  type="button"
                  onClick={() => onStartEditNote(a.id)}
                  className="mt-1 text-[10.5px] text-ink-3 transition-colors hover:text-accent"
                >
                  + 添加笔记
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function AskPane({
  item,
  messages,
  streaming,
  error,
  input,
  context,
  onInput,
  onSend,
  onStop,
  onClearContext,
  inputRef,
}: {
  item: Item;
  messages: PaperAskMessage[];
  streaming: boolean;
  error: string;
  input: string;
  context: PaperAskContext | null;
  onInput: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  onClearContext: () => void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
}): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages, streaming]);

  const hasSelection = (context?.selection ?? '') !== '';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={listRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-5 text-center">
            <Icon name="chat" size={18} className="text-ink-3" />
            <p className="text-[12px] leading-relaxed text-ink-3">
              划选正文后点「提问」，我会结合当前页内容作答。
              <br />
              不选中也可以直接问当前页的问题。
            </p>
          </div>
        ) : null}

        {messages.map((m, i) =>
          m.role === 'user' ? (
            <div key={i} className="flex justify-end">
              <div className="max-w-[92%] whitespace-pre-wrap rounded-tile rounded-tr-sm bg-fill-2 px-2.5 py-1.5 text-[11.5px] leading-relaxed text-ink">
                {m.content}
              </div>
            </div>
          ) : (
            <div key={i} className="max-w-full whitespace-pre-wrap rounded-tile rounded-tl-sm border border-line bg-raised px-2.5 py-1.5 text-[11.5px] leading-relaxed text-ink-2">
              {m.content}
              {streaming && i === messages.length - 1 ? <span className="ml-0.5 inline-block animate-pulse text-accent">▍</span> : null}
            </div>
          ),
        )}

        {error !== '' ? (
          <div className="rounded-tile border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-danger">{error}</div>
        ) : null}
      </div>

      <div className="shrink-0 border-t border-line px-3 py-2.5">
        {context !== null ? (
          <div className="mb-2 flex items-center justify-between gap-2 rounded-tile border border-line bg-sunken px-2 py-1.5">
            <div className="min-w-0 text-[10.5px] leading-snug text-ink-3">
              {hasSelection ? (
                <>
                  <span className="text-accent">「{truncate(context.selection, 42)}」</span>
                  <span className="num ml-1">· 第 {context.page} 页</span>
                </>
              ) : (
                <>
                  提问上下文：<span className="num">第 {context.page} 页全文</span>
                </>
              )}
            </div>
            <button type="button" onClick={onClearContext} className="shrink-0 text-[10.5px] text-ink-3 hover:text-danger" title="清除上下文">
              清除
            </button>
          </div>
        ) : null}

        <div className="flex items-end gap-1.5">
          <textarea
            ref={inputRef}
            value={input}
            placeholder={`针对《${truncate(item.title, 18)}》提问…`}
            className="input max-h-28 min-h-[38px] flex-1 resize-none text-[12px]"
            onChange={(e) => onInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                onSend();
              }
            }}
          />
          {streaming ? (
            <button type="button" className="btn h-[38px] shrink-0" onClick={onStop} title="停止生成">
              <Icon name="x" size={13} />
            </button>
          ) : (
            <button type="button" className="btn btn-accent h-[38px] shrink-0" onClick={onSend} disabled={input.trim() === ''}>
              <Icon name="send" size={13} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
