/**
 * 论文阅读器：全屏覆盖层，完整保留 PDF 原版排版。
 *
 * 打开即自动下载（幂等）：状态 none/failed → POST 下载并等待；ready → 直接读本地文件。
 * 选中文本浮出工具栏：高亮（5 色）/ 笔记 / 提问；右侧面板管理标注与流式问答。
 * 会话提问走 /api/items/:id/paper/ask（SSE），上下文 = 选中文本 + 当前页全文。
 */
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import type { Item } from '../lib/types';
import { loadPdf, type PDFDocumentProxy } from '../lib/pdf';
import {
  ANNOTATION_COLORS,
  type AnnotationColor,
  type PaperAnnotation,
  type PaperAskContext,
  type PaperAskMessage,
  type PaperInfo,
  addAnnotation,
  downloadPaper,
  getPaperStatus,
  listAnnotations,
  paperFileUrl,
  removeAnnotation,
  streamPaperAsk,
  updateAnnotation,
} from '../lib/paper';
import { Icon } from '../components/Icon';
import { displayTitle } from '../components/ItemCard';
import { ReaderPanel, type ReaderTab } from './ReaderPanel';
import { PdfPageView, type PageSelection } from './PdfPageView';

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const ZOOM_STEP = 1.15;

export function PaperReader({ item, onClose }: { item: Item; onClose: () => void }): JSX.Element {
  // ---- 下载与文档 ----
  const [paper, setPaper] = useState<PaperInfo | null>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [docError, setDocError] = useState('');
  const [numPages, setNumPages] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [fitScale, setFitScale] = useState(1);
  const [basePageWidth, setBasePageWidth] = useState(595);

  // ---- UI 状态 ----
  const scrollRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef(new Map<number, HTMLDivElement>());
  const pageTextsRef = useRef(new Map<number, string>());
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [panelTab, setPanelTab] = useState<ReaderTab>('annotations');

  // ---- 标注 ----
  const [annotations, setAnnotations] = useState<PaperAnnotation[]>([]);
  const [activeAnnotationId, setActiveAnnotationId] = useState<string | undefined>(undefined);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);

  // ---- 选区 ----
  const [selection, setSelection] = useState<PageSelection | null>(null);

  // ---- 提问 ----
  const [askMessages, setAskMessages] = useState<PaperAskMessage[]>([]);
  const [askStreaming, setAskStreaming] = useState(false);
  const [askError, setAskError] = useState('');
  const [askInput, setAskInput] = useState('');
  const [askContext, setAskContext] = useState<PaperAskContext | null>(null);
  const askInputRef = useRef<HTMLTextAreaElement>(null);
  const askAbortRef = useRef<AbortController | null>(null);

  const destroyPdfRef = useRef<(() => void) | null>(null);

  const handleTextExtracted = useCallback((page: number, text: string) => {
    pageTextsRef.current.set(page, text);
  }, []);

  const handlePageVisible = useCallback((page: number) => {
    setCurrentPage((cur) => Math.min(cur, page));
  }, []);

  // ---------------------------------------------------------------- 状态 → 下载 → 加载

  /** 下载完成后的统一出口：ready 就加载标注与 PDF；effect 与手动重试共用 */
  const settleAndLoad = useCallback(
    (info: PaperInfo): void => {
      setPaper(info);
      if (info.status !== 'ready') return;
      void listAnnotations(item.id)
        .then((list) => setAnnotations(list))
        .catch(() => {
          // 标注加载失败不挡阅读：列表空，重开恢复
        });
      setDocError('');
      // 先销毁上一次的加载任务（重试场景），再开新的
      destroyPdfRef.current?.();
      const handle = loadPdf(paperFileUrl(item.id));
      destroyPdfRef.current = () => void handle.destroy();
      void handle.promise
        .then((loaded) => {
          setDoc(loaded);
          setNumPages(loaded.numPages);
        })
        .catch((err: unknown) => {
          setDocError(err instanceof Error ? err.message : 'PDF 加载失败');
        });
    },
    [item.id],
  );

  const retryDownload = useCallback((): void => {
    setPaper((cur) => ({ ...(cur ?? { itemId: item.id, status: 'none', originUrl: '', bytes: null, error: '', downloadedAt: null, updatedAt: '' }), status: 'pending' }));
    void downloadPaper(item.id)
      .then(settleAndLoad)
      .catch((err: unknown) => {
        setPaper({
          itemId: item.id,
          status: 'failed',
          originUrl: '',
          bytes: null,
          error: err instanceof Error ? err.message : '下载服务不可用',
          downloadedAt: null,
          updatedAt: '',
        });
      });
  }, [item.id, settleAndLoad]);

  useEffect(() => {
    let cancelled = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    if (pollTimerRef.current !== null) clearInterval(pollTimerRef.current);
    pollTimerRef.current = null;

    const startPolling = (): void => {
      pollTimerRef.current = setInterval(() => {
        void getPaperStatus(item.id).then((next) => {
          if (cancelled) return;
          if (next.status !== 'pending') {
            if (pollTimerRef.current !== null) clearInterval(pollTimerRef.current);
            pollTimerRef.current = null;
            settleAndLoad(next);
          } else {
            setPaper(next);
          }
        });
      }, 1500);
    };

    void (async () => {
      try {
        const info = await getPaperStatus(item.id);
        if (cancelled) return;
        setPaper(info);
        if (info.status === 'ready') {
          settleAndLoad(info);
          return;
        }
        if (info.status === 'pending') {
          // 别的会话已在下载：轮询等它结束
          startPolling();
          return;
        }
        // none / failed → 打开即自动（重试）下载
        retryDownload();
      } catch (err) {
        if (!cancelled) {
          setPaper({
            itemId: item.id,
            status: 'failed',
            originUrl: '',
            bytes: null,
            error: err instanceof Error ? err.message : '下载服务不可用',
            downloadedAt: null,
            updatedAt: '',
          });
        }
      }
    })();

    return () => {
      cancelled = true;
      if (pollTimerRef.current !== null) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [item.id, settleAndLoad, retryDownload]);

  // 阅读器卸载时销毁文档，释放 pdf.js worker 内存。
  // 刻意不依赖 [doc]：dep 变化时的 cleanup 会在「null → 文档」这一跳把刚建好的任务杀掉。
  useEffect(() => {
    return () => {
      destroyPdfRef.current?.();
      destroyPdfRef.current = null;
    };
  }, []);

  // 适宽：文档加载后按容器宽度与首页实际尺寸算初始缩放
  useEffect(() => {
    if (!doc) return;
    const scroll = scrollRef.current;
    if (!scroll) return;
    void doc.getPage(1).then((page) => {
      const base = page.getViewport({ scale: 1 });
      const available = Math.max(280, scroll.clientWidth - 48);
      const fit = available / base.width;
      setBasePageWidth(base.width);
      setFitScale(fit);
      setZoom(fit);
    });
  }, [doc]);

  // ---------------------------------------------------------------- 滚动跟随：滚动时更新当前页码

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    let raf = 0;
    const onScroll = (): void => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const top = scroll.getBoundingClientRect().top;
        let current = 1;
        for (const [page, el] of pageRefs.current) {
          const box = el.getBoundingClientRect();
          if (box.top - top <= scroll.clientHeight * 0.35) current = page;
          else break;
        }
        setCurrentPage((prev) => (prev === current ? prev : current));
      });
    };
    scroll.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      scroll.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(raf);
    };
  }, [doc]);

  // ---------------------------------------------------------------- 标注操作

  const jumpToPage = useCallback((page: number, annotationId?: string): void => {
    const el = pageRefs.current.get(page);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (annotationId) {
      setActiveAnnotationId(annotationId);
      // 短暂高亮后清除描边
      setTimeout(() => setActiveAnnotationId((cur) => (cur === annotationId ? undefined : cur)), 2400);
    }
  }, []);

  const handleHighlight = useCallback(
    async (color: AnnotationColor): Promise<void> => {
      if (!selection) return;
      try {
        const created = await addAnnotation(item.id, {
          page: selection.page,
          rects: selection.rects,
          text: selection.text,
          color,
        });
        setAnnotations((list) => [...list, created]);
        jumpToPage(created.page, created.id);
      } catch {
        // 保存失败保持选区，用户可重试
        return;
      }
      setSelection(null);
      window.getSelection()?.removeAllRanges();
    },
    [selection, item.id, jumpToPage],
  );

  const handleNote = useCallback((): void => {
    if (!selection) return;
    void (async () => {
      try {
        const created = await addAnnotation(item.id, {
          page: selection.page,
          rects: selection.rects,
          text: selection.text,
          note: '',
          color: ANNOTATION_COLORS[0],
        });
        setAnnotations((list) => [...list, created]);
        setPanelTab('annotations');
        setEditingNoteId(created.id);
        jumpToPage(created.page, created.id);
        setSelection(null);
        window.getSelection()?.removeAllRanges();
      } catch {
        // 同上：失败保留选区
      }
    })();
  }, [selection, item.id, jumpToPage]);

  const handleAsk = useCallback((): void => {
    if (!selection) return;
    const page = selection.page;
    setAskContext({ page, pageText: pageTextsRef.current.get(page) ?? '', selection: selection.text });
    setPanelTab('ask');
    setSelection(null);
    window.getSelection()?.removeAllRanges();
    setTimeout(() => askInputRef.current?.focus(), 60);
  }, [selection]);

  const handleSaveNote = useCallback(
    (a: PaperAnnotation, note: string): void => {
      setEditingNoteId(null);
      void updateAnnotation(item.id, a.id, { note })
        .then((updated) => {
          if (updated) setAnnotations((list) => list.map((it) => (it.id === updated.id ? updated : it)));
        })
        .catch(() => {
          // 网络失败：本地先回显，下次保存再覆盖（标注列表不回滚，避免打断写作流）
          setAnnotations((list) => list.map((it) => (it.id === a.id ? { ...it, note } : it)));
        });
    },
    [item.id],
  );

  const handleColorChange = useCallback(
    (a: PaperAnnotation, color: AnnotationColor): void => {
      setAnnotations((list) => list.map((it) => (it.id === a.id ? { ...it, color } : it)));
      void updateAnnotation(item.id, a.id, { color }).catch(() => {});
    },
    [item.id],
  );

  const handleDelete = useCallback(
    (a: PaperAnnotation): void => {
      setAnnotations((list) => list.filter((it) => it.id !== a.id));
      if (editingNoteId === a.id) setEditingNoteId(null);
      void removeAnnotation(item.id, a.id).catch(() => {});
    },
    [item.id, editingNoteId],
  );

  // ---------------------------------------------------------------- 提问流（SSE）

  const sendAsk = useCallback((): void => {
    const question = askInput.trim();
    if (question === '' || askStreaming) return;
    const context: PaperAskContext =
      askContext ?? { page: currentPage, pageText: pageTextsRef.current.get(currentPage) ?? '', selection: '' };
    const history = askMessages.filter((m) => m.content !== '').slice(-6);
    const userMessage: PaperAskMessage = {
      role: 'user',
      content: context.selection !== '' ? `【选中原文】“${context.selection}”\n\n${question}` : question,
    };
    setAskMessages((list) => [...list, userMessage, { role: 'assistant', content: '' }]);
    setAskInput('');
    setAskError('');
    setAskStreaming(true);

    const controller = new AbortController();
    askAbortRef.current = controller;
    const appendToken = (text: string): void => {
      setAskMessages((list) => {
        const copy = [...list];
        const last = copy[copy.length - 1];
        if (last?.role === 'assistant') copy[copy.length - 1] = { ...last, content: last.content + text };
        return copy;
      });
    };
    /** 失败时把「空的 assistant 占位」撤掉，用户重发不重复 */
    const dropEmptyAssistant = (): void => {
      setAskMessages((list) => {
        const last = list[list.length - 1];
        return last?.role === 'assistant' && last.content === '' ? list.slice(0, -1) : list;
      });
    };
    void streamPaperAsk(
      { itemId: item.id, question, context, history },
      {
        onToken: appendToken,
        onError: (_code, message) => {
          setAskError(message);
          dropEmptyAssistant();
        },
      },
      controller.signal,
    )
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : '提问失败';
        setAskError(message.includes('LLM') ? `${message}：可在设置页配置 LLM 后重试` : message);
        dropEmptyAssistant();
      })
      .finally(() => {
        setAskStreaming(false);
        askAbortRef.current = null;
      });
  }, [askInput, askStreaming, askContext, askMessages, currentPage, item.id]);

  const stopAsk = useCallback((): void => {
    askAbortRef.current?.abort();
    askAbortRef.current = null;
    setAskStreaming(false);
  }, []);

  // ---------------------------------------------------------------- Esc 关闭 / 窗口 resize 重算适宽

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        // 有选区时先收选区，再关阅读器
        if (selection !== null) {
          setSelection(null);
          window.getSelection()?.removeAllRanges();
          return;
        }
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selection, onClose]);

  const paperStatus = paper?.status ?? 'none';
  const pageWidth = Math.round(basePageWidth * zoom);

  return (
    <div className="paper-reader fixed inset-0 z-[70] flex flex-col bg-canvas" role="dialog" aria-modal="true" aria-label="论文阅读器">
      {/* 顶栏 */}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-surface px-3">
        <Icon name="book" size={16} className="shrink-0 text-accent" />
        <h2 className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink" title={displayTitle(item)}>
          {displayTitle(item)}
        </h2>

        {doc !== null ? (
          <div className="hidden items-center gap-1 sm:flex">
            <IconButton label="缩小" onClick={() => setZoom((z) => Math.max(ZOOM_MIN, z / ZOOM_STEP))} icon="minus" />
            <button
              type="button"
              onClick={() => setZoom(fitScale)}
              className="num rounded-md px-1.5 py-1 text-[11px] text-ink-3 transition-colors hover:bg-fill-2 hover:text-accent"
              title="恢复适宽"
            >
              {Math.round((zoom / (fitScale || 1)) * 100)}%
            </button>
            <IconButton label="放大" onClick={() => setZoom((z) => Math.min(ZOOM_MAX, z * ZOOM_STEP))} icon="plus" />
          </div>
        ) : null}

        <span className="num hidden text-[11px] text-ink-3 md:inline">{doc !== null ? `${currentPage} / ${numPages}` : ''}</span>

        {paperStatus === 'ready' ? (
          <a
            href={paperFileUrl(item.id)}
            download={`${item.id}.pdf`}
            target="_blank"
            rel="noreferrer noopener"
            className="btn h-8 px-2.5 text-[12px]"
            title="下载 PDF 原文件"
          >
            <Icon name="external" size={12} />
            PDF
          </a>
        ) : null}
        <button type="button" onClick={onClose} className="btn h-8 px-2.5 text-[12px]" title="关闭阅读器（Esc）">
          <Icon name="x" size={13} />
          关闭
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* 正文区 */}
        <div ref={scrollRef} className="paper-reader-scroll min-w-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
          {paperStatus === 'pending' ? (
            <CenterHint icon="refresh" title="正在下载论文…">
              <Spinner />
              <p className="text-[12px] text-ink-3">从 arXiv 拉取 PDF，通常几秒；完成后自动打开。</p>
            </CenterHint>
          ) : null}

          {paperStatus === 'failed' ? (
            <CenterHint icon="alert" title="论文 PDF 不可用">
              <p className="max-w-md text-center text-[12px] leading-relaxed text-ink-2">
                {paper?.error !== '' && paper?.error !== undefined ? paper.error : '下载失败，请稍后重试。'}
              </p>
              <button type="button" className="btn btn-accent" onClick={retryDownload}>
                <Icon name="refresh" size={13} />
                重试下载
              </button>
              <a href={item.url} target="_blank" rel="noreferrer noopener" className="btn text-[12px]">
                <Icon name="external" size={13} />
                打开原文网页
              </a>
            </CenterHint>
          ) : null}

          {docError !== '' ? (
            <CenterHint icon="alert" title="PDF 加载失败">
              <p className="text-[12px] text-ink-2">{docError}</p>
              <button
                type="button"
                className="btn btn-accent"
                onClick={() => {
                  setDocError('');
                  destroyPdfRef.current?.();
                  const handle = loadPdf(paperFileUrl(item.id));
                  destroyPdfRef.current = () => void handle.destroy();
                  void handle.promise.then(setDoc).catch((err: unknown) => setDocError(err instanceof Error ? err.message : '加载失败'));
                }}
              >
                重试
              </button>
            </CenterHint>
          ) : null}

          {doc !== null ? (
            <div className="mx-auto" style={{ width: pageWidth }}>
              {Array.from({ length: numPages }, (_, i) => (
                <div key={i + 1} ref={(el) => { if (el) pageRefs.current.set(i + 1, el); else pageRefs.current.delete(i + 1); }}>
                  <PdfPageView
                    pdf={doc}
                    pageNumber={i + 1}
                    width={pageWidth}
                    annotations={annotations.filter((a) => a.page === i + 1)}
                    activeAnnotationId={activeAnnotationId}
                    onTextExtracted={handleTextExtracted}
                    onSelect={setSelection}
                    onSelectionCleared={() => setSelection(null)}
                    onVisible={handlePageVisible}
                  />
                </div>
              ))}
            </div>
          ) : null}
        </div>

        {/* 右侧面板 */}
        <ReaderPanel
          item={item}
          tab={panelTab}
          onTabChange={setPanelTab}
          annotations={annotations}
          activeAnnotationId={activeAnnotationId}
          editingNoteId={editingNoteId}
          onJumpToAnnotation={(a) => jumpToPage(a.page, a.id)}
          onStartEditNote={setEditingNoteId}
          onSaveNote={handleSaveNote}
          onColorChange={handleColorChange}
          onDelete={handleDelete}
          askMessages={askMessages}
          askStreaming={askStreaming}
          askError={askError}
          askInput={askInput}
          askContext={askContext}
          onAskInput={setAskInput}
          onAskSend={sendAsk}
          onAskStop={stopAsk}
          onClearAskContext={() => setAskContext(null)}
          askInputRef={askInputRef}
        />
      </div>

      {/* 选区浮层工具栏 */}
      {selection !== null ? (
        <div
          className="fixed z-[80] flex items-center gap-1 rounded-tile border border-line-strong bg-raised px-1.5 py-1 shadow-lg"
          style={{
            left: Math.min(Math.max(12, selection.anchorX - 140), window.innerWidth - 260),
            top: Math.min(selection.anchorY + 10, window.innerHeight - 60),
          }}
          onPointerDown={(e) => e.preventDefault()}
        >
          <span className="px-1 text-[10.5px] text-ink-3">高亮</span>
          {ANNOTATION_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              title="高亮"
              onClick={() => void handleHighlight(c)}
              className="h-4 w-4 rounded-full border border-line-strong transition-transform hover:scale-110"
              style={{ backgroundColor: c }}
            />
          ))}
          <span className="mx-0.5 h-4 w-px bg-line-strong" />
          <button type="button" className="btn h-7 px-2 text-[11.5px]" onClick={handleNote}>
            <Icon name="pen" size={12} />
            笔记
          </button>
          <button type="button" className="btn btn-accent h-7 px-2 text-[11.5px]" onClick={handleAsk}>
            <Icon name="chat" size={12} />
            提问
          </button>
        </div>
      ) : null}
    </div>
  );
}

function IconButton({ label, onClick, icon }: { label: string; onClick: () => void; icon: 'plus' | 'minus' }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="flex h-7 w-7 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-fill-2 hover:text-accent"
    >
      <Icon name={icon} size={13} />
    </button>
  );
}

function CenterHint({ icon, title, children }: { icon: 'alert' | 'refresh'; title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 py-24">
      <Icon name={icon} size={22} className="text-ink-3" />
      <h3 className="text-[14px] font-medium text-ink">{title}</h3>
      {children}
    </div>
  );
}

function Spinner(): JSX.Element {
  return (
    <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-line-strong border-t-accent" aria-hidden="true" />
  );
}
