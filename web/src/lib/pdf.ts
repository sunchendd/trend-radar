/**
 * pdf.js 装配：worker 与主库同版本、同构建，从本地 bundle 加载（不出网）。
 *
 * 为什么不用 CDN：看板的可用性押在自己身上——离线/内网环境必须照常能读论文。
 * v6 起 destroy 在 loading task 上（不在 document proxy 上），用 loadPdf 统一封装。
 */
import * as pdfjs from 'pdfjs-dist';
// vite 的 `?url` 导入会把 worker 文件打进产物并给出最终 URL
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export { pdfjs };
export type PDFDocumentProxy = Awaited<ReturnType<typeof pdfjs.getDocument>['promise']>;
export type PDFPageProxy = Awaited<ReturnType<PDFDocumentProxy['getPage']>>;

export interface LoadedPdfHandle {
  promise: Promise<PDFDocumentProxy>;
  /** 中止网络请求并销毁 worker 端文档（v6：PDFDocumentLoadingTask.destroy） */
  destroy(): Promise<void>;
}

export function loadPdf(url: string): LoadedPdfHandle {
  const task = pdfjs.getDocument({ url });
  return { promise: task.promise, destroy: () => task.destroy() };
}
