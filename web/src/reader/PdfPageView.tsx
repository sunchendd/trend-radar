/**
 * PDF 单页视图：canvas 渲染 + 文本层 + 高亮叠加 + 选区捕获。
 *
 * 性能关键点：只有进入视口附近（rootMargin 500px）才真正渲染；
 * 宽度变化（缩放）时先取消上一次 RenderTask 再重画，避免半截页面。
 * 选区矩形按「归一化坐标」上报（0–1，相对页面宽高），缩放后依然正确。
 */
import { useEffect, useRef, useState, type JSX } from 'react';
import { pdfjs, type PDFDocumentProxy } from '../lib/pdf';
import type { PaperAnnotation, PaperRect } from '../lib/paper';

export interface PageSelection {
  page: number;
  rects: PaperRect[];
  text: string;
  /** 选区末尾相对视口的位置（浮层工具栏定位用） */
  anchorX: number;
  anchorY: number;
}

export function PdfPageView({
  pdf,
  pageNumber,
  width,
  annotations,
  activeAnnotationId,
  onTextExtracted,
  onSelect,
  onSelectionCleared,
  onVisible,
}: {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  /** 页面 CSS 宽度（px）；高度按 PDF 页比例自动算 */
  width: number;
  annotations: PaperAnnotation[];
  activeAnnotationId?: string;
  onTextExtracted: (page: number, text: string) => void;
  onSelect: (selection: PageSelection) => void;
  onSelectionCleared: () => void;
  /** 页面首次进入渲染范围时回调（滚动跟随用） */
  onVisible?: (page: number) => void;
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const textExtractedRef = useRef(false);
  const [visible, setVisible] = useState(false);
  const [height, setHeight] = useState(width * 1.414);

  // 懒加载：进入滚动容器附近才开始渲染。前三页通常首屏可见，直接渲染省一次 IO 往返
  useEffect(() => {
    if (visible) return;
    const el = hostRef.current;
    if (!el) return;
    const root = el.closest('.paper-reader-scroll');
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          onVisible?.(pageNumber);
          io.disconnect();
        }
      },
      { root: (root as Element | null) ?? null, rootMargin: '600px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visible, onVisible, pageNumber]);

  // 渲染：canvas（原版排版）+ TextLayer（可选中文本）
  useEffect(() => {
    if (!visible || width <= 0) return;
    let cancelled = false;
    let renderTask: { cancel: () => void; promise: Promise<void> } | null = null;
    let textLayer: { cancel: () => void } | null = null;

    void (async () => {
      const page = await pdf.getPage(pageNumber);
      if (cancelled) return;
      const base = page.getViewport({ scale: 1 });
      const scale = width / base.width;
      const viewport = page.getViewport({ scale });
      setHeight(viewport.height);

      const host = hostRef.current;
      const canvas = canvasRef.current;
      const textDiv = textRef.current;
      if (!host || !canvas || !textDiv) return;

      host.style.width = `${viewport.width}px`;
      host.style.height = `${viewport.height}px`;
      // pdf.js v6 的 TextLayer 用这个变量推导文字缩放
      host.style.setProperty('--total-scale-factor', String(viewport.scale));

      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;

      const task = page.render({
        canvas,
        viewport,
        background: '#ffffff',
        ...(ratio !== 1 ? { transform: [ratio, 0, 0, ratio, 0, 0] } : {}),
      });
      renderTask = task;
      await task.promise.catch(() => {
        // 渲染被取消（缩放中/卸载）是常态，不当错误
      });
      if (cancelled) return;

      textDiv.replaceChildren();
      const layer = new pdfjs.TextLayer({
        textContentSource: page.streamTextContent(),
        container: textDiv,
        viewport,
      });
      textLayer = layer;
      await layer.render().catch(() => {});
      if (cancelled) return;

      if (!textExtractedRef.current) {
        textExtractedRef.current = true;
        try {
          const content = await page.getTextContent();
          let text = '';
          for (const item of content.items) {
            if ('str' in item) {
              text += item.str;
              if (item.hasEOL) text += '\n';
            }
          }
          onTextExtracted(pageNumber, text);
        } catch {
          onTextExtracted(pageNumber, '');
        }
      }
    })();

    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
    };
  }, [visible, width, pdf, pageNumber, onTextExtracted]);

  /** 选区捕获：把浏览器选区映射成归一化矩形 + 文本 */
  const handlePointerUp = (): void => {
    const host = hostRef.current;
    const textDiv = textRef.current;
    const sel = window.getSelection();
    if (!host || !textDiv || !sel || sel.isCollapsed || sel.rangeCount === 0) return;

    const range = sel.getRangeAt(0);
    if (!range.intersectsNode(textDiv)) return;

    const box = host.getBoundingClientRect();
    const rects: PaperRect[] = [];
    let anchorX = 0;
    let anchorY = 0;
    for (const r of Array.from(range.getClientRects())) {
      if (r.width < 1 || r.height < 1) continue;
      const nx = (r.left - box.left) / box.width;
      const ny = (r.top - box.top) / box.height;
      const nw = r.width / box.width;
      const nh = r.height / box.height;
      // 只保留落在本页内的部分（跨页拖选时另一页的矩形坐标会出界）
      if (nx + nw <= 0 || nx >= 1 || ny + nh <= 0 || ny >= 1) continue;
      rects.push({
        x: Math.max(0, nx),
        y: Math.max(0, ny),
        w: Math.min(1 - Math.max(0, nx), nw),
        h: Math.min(1 - Math.max(0, ny), nh),
      });
      anchorX = r.right;
      anchorY = r.bottom;
    }
    const text = sel.toString().trim();
    if (rects.length === 0 || text === '') return;
    onSelect({ page: pageNumber, rects, text, anchorX, anchorY });
  };

  return (
    <div className="mb-4 flex flex-col items-center" data-page={pageNumber}>
      <div
        ref={hostRef}
        className="relative select-text bg-white shadow-[0_1px_8px_rgb(0_0_0/0.45)]"
        style={{ width, minHeight: visible ? height : Math.round(width * 1.414) }}
        onPointerUp={handlePointerUp}
        onPointerDown={onSelectionCleared}
      >
        {!visible ? (
          <div className="flex h-full w-full items-center justify-center bg-white">
            <span className="num text-[12px] text-neutral-400">第 {pageNumber} 页…</span>
          </div>
        ) : null}
        {/* 高亮层：在 canvas 之上、文本层之下；multiply 让底下文字保持可读 */}
        <div className="pointer-events-none absolute inset-0 z-[1]" aria-hidden="true">
          {annotations.map((a) =>
            a.rects.map((r, i) => (
              <div
                key={`${a.id}-${i}`}
                className={`reader-highlight${a.id === activeAnnotationId ? ' reader-active-annotation' : ''}`}
                style={{
                  left: `${r.x * 100}%`,
                  top: `${r.y * 100}%`,
                  width: `${r.w * 100}%`,
                  height: `${r.h * 100}%`,
                  backgroundColor: a.color,
                }}
              />
            )),
          )}
        </div>
        <canvas ref={canvasRef} className="absolute inset-0 z-0" />
        <div ref={textRef} className="textLayer absolute inset-0 z-[2]" />
      </div>
      <div className="num mt-1.5 text-[10.5px] text-ink-3">{pageNumber}</div>
    </div>
  );
}
