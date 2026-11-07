/**
 * PDF 来源解析：给定一条情报条目，推断出可直接下载的 PDF 地址。
 *
 * 三条解析路径（按可靠度排序）：
 * 1. arXiv：externalId 或 arxiv.org 链接 → `https://arxiv.org/pdf/<id>`（官方 PDF 端点，
 *    免登录、稳定；这是库内论文条目的绝对主力）；
 * 2. 链接本身就是 PDF（.pdf 后缀）→ 原样使用；
 * 3. Google Patents：`patents.google.com/patent/<号>` → 抓页面里「Download PDF」按钮指向的
 *    patentimages.storage.googleapis.com 链接（免登录，但页面结构可能变，失败要如实报错）。
 *
 * 解析不出 → 返回 null，由调用方给出 `paper_no_pdf` 错误，绝不拿 HTML 冒充 PDF。
 */

const ARXIV_ID = /(\d{4}\.\d{4,5})(v\d+)?/i;

export interface PdfSource {
  /** 条目原始 url（落库留痕） */
  itemUrl: string;
  /** 解析出的 PDF 下载地址 */
  pdfUrl: string;
  /** 哪条规则命中的（日志/错误信息用） */
  via: 'arxiv' | 'direct' | 'google-patents';
}

export function resolvePdfUrl(item: { url: string; externalId?: string }): PdfSource | null {
  const url = item.url.trim();

  // 1) arXiv：externalId 优先（跨源去重后的规范 id），其次 arxiv.org 链接
  const arxivRaw = item.externalId ?? '';
  const arxivMatch = ARXIV_ID.exec(arxivRaw) ?? (/arxiv\.org\/(abs|pdf)\//i.test(url) ? ARXIV_ID.exec(url) : null);
  if (arxivMatch) {
    return { itemUrl: url, pdfUrl: `https://arxiv.org/pdf/${arxivMatch[1]}`, via: 'arxiv' };
  }

  // 2) 链接本身就是 PDF：`.pdf` 后缀，或路径以 `/pdf` 结尾（OpenReview 等站的
  //    `/pdf?id=…` 也是直出 PDF）。伪 PDF 由下载器的魔数校验兜底。
  if (/^https?:\/\//i.test(url) && (/\.pdf(\?|#|$)/i.test(url) || /\/pdf(\?|#|$)/i.test(url))) {
    return { itemUrl: url, pdfUrl: url, via: 'direct' };
  }

  // 3) Google Patents：返回 marker，下载器先抓页面再解析出真实 PDF 地址
  //    真实链接形如 /patent/US1234567B2/en、/patent/CN119123456A/zh（语言段可选）
  const gp = /^https?:\/\/patents\.google\.com\/patent\/([A-Za-z0-9]+)(?:\/[a-z-]+)?\/?(\?|#|$)/i.exec(url);
  if (gp) return { itemUrl: url, pdfUrl: url, via: 'google-patents' };

  return null;
}

/**
 * Google Patents 页面 → 真实 PDF 地址。
 * 页面里的 Download PDF 是 `<a href="https://patentimages.storage.googleapis.com/…pdf">`，
 * 只认这个 host，防止把页面里其它任意链接当 PDF。
 */
export function extractPatentPdfLink(html: string): string | null {
  const link = /href="(https:\/\/patentimages\.storage\.googleapis\.com\/[^"]+\.pdf)"/i.exec(html);
  return link?.[1] ?? null;
}
