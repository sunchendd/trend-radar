/**
 * 极简安全 Markdown 渲染器（零依赖，供对话页助手消息用）。
 *
 * 为什么安全 —— 整个文件只有一条数据流：**先整体 HTML 转义，再解析受限语法**。
 *
 * 1. `renderChatMarkdown()` 第一步就把全部输入经 `escapeHtml()` 转义（& < > " '）。
 *    之后所有解析都在已转义文本上进行，因此不存在「原始 HTML 重新进入输出」的路径：
 *    `<script>`、`<img onerror=…>`、`<a href="…">` 之类的标签在转义后只是普通文本，
 *    属性引号变成 `&quot;` / `&#39;`，无法构造出任何标签或属性边界。
 * 2. 链接协议白名单：只有 `http://` / `https://`（大小写不敏感前缀）会被链接化，
 *    其它一律按纯文本输出。`javascript:`、`data:`、`vbscript:` 以及带实体花招的
 *    `java&#x0A;script:`（转义后是 `java&amp;#x0A;script:`，协议检查必然不通过）
 *    都 matched 不到白名单。
 * 3. `href` 的值本身也是已转义文本（引号已是实体），无法逃出属性引号边界；
 *    `target="_blank" rel="noopener noreferrer"` 是本文件写死的字面量，不受输入影响。
 * 4. 输出标签集合封闭：p / br / strong / code / pre / ul / li / h4 / a，全部由本文件
 *    的字面量字符串拼出；输入内容只可能出现在「文本位置」或「已转义后的 href」里。
 * 5. 链接文字与占位符：markdown 链接先渲染成内部占位符（\u0000LINK<i>n</i>\u0000），
 *    裸 URL 扫描因此绝不会命中我们自己生成的 `href="…"`。占位符碰撞的最坏结果是
 *    把用户的同名文本换成我们**已渲染好**的安全 <a>，不构成注入面。
 *
 * 支持的语法：段落 / 换行、**粗体**、`行内码`、``` 围栏代码块、- 与 * 无序列表、
 * #~###### 标题（统一渲染为 h4，聊天气泡里不需要更深的层级）、[文本](url)、裸 URL。
 */

const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** 把任意文本变成安全的 HTML 文本（先于一切解析执行） */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPE_MAP[c] ?? c);
}

/**
 * URL 白名单：http/https 且不含空白（输入已转义，不可能再出现裸引号/尖括号，
 * 所以「无空白」就足以排除属性逃逸）。
 */
const SAFE_URL = /^https?:\/\/\S+$/i;

/** markdown 链接：[text](url) —— url 里不允许空白与右括号 */
const LINK_RE = /\[([^\]\n]+)\]\(([^)\n]+)\)/g;

/** 裸 URL：仅 ASCII 的 URL 字符集，末字符不吃标点（中文句读与正文不会被吞进链接） */
const BARE_URL_RE = /https?:\/\/[A-Za-z0-9\-._~:/?#@!$&()*+,;=%]+[A-Za-z0-9\-_~:/?#@!$&+=%]/g;

const BOLD_RE = /\*\*([^*\n]+?)\*\*/g;

/** 行内码：`…`（成对、不跨行；转义不碰反引号，所以码段原样保留）。
 *  必须带捕获组：split() 只有在正则有捕获组时才会把匹配段保留进结果（奇数下标）。 */
const CODE_RE = /(`[^`\n]+`)/g;

/** 渲染不含链接语法的行内片段（粗体 + 行内码） */
function renderInlineBase(escaped: string): string {
  // 先切出码段，码段内不做任何其它解析（`**x**` 在码里就是字面量）
  const parts = escaped.split(CODE_RE);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return `<code>${part.slice(1, -1)}</code>`;
      return part.replace(BOLD_RE, '<strong>$1</strong>');
    })
    .join('');
}

/** 行内渲染：占位化 markdown 链接 → 粗体/码 → 裸 URL → 还原 */
function renderInline(escaped: string): string {
  const stored: string[] = [];
  const withPlaceholders = escaped.replace(LINK_RE, (_m, text: string, url: string) => {
    const html = SAFE_URL.test(url)
      ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${renderInlineBase(text)}</a>`
      : `${text}(${url})`; // 非法协议：原样还原为文本，绝不生成 <a>
    stored.push(html);
    return `\u0000LINK${stored.length - 1}\u0000`;
  });

  // 粗体/行内码先落地；裸 URL 后扫（其字符集不含 <，不会命中已生成的标签内部属性）
  const withBold = renderInlineBase(withPlaceholders);
  const withInline = withBold.replace(BARE_URL_RE, (url) =>
    SAFE_URL.test(url) ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>` : url,
  );

  return withInline.replace(/\u0000LINK(\d+)\u0000/g, (_m, i: string) => stored[Number(i)] ?? '');
}

export function renderChatMarkdown(md: string): string {
  const escaped = escapeHtml(String(md));
  const lines = escaped.split('\n');

  const blocks: string[] = [];
  let para: string[] = [];
  let list: string[] = [];
  let fence: string[] | null = null;

  const flushPara = () => {
    if (para.length === 0) return;
    blocks.push(`<p>${para.map(renderInline).join('<br>')}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list.length === 0) return;
    blocks.push(`<ul>${list.map((li) => `<li>${renderInline(li)}</li>`).join('')}</ul>`);
    list = [];
  };
  const flushAll = () => {
    flushList();
    flushPara();
  };

  for (const line of lines) {
    // 围栏代码块：内部不再做行内解析，只保留换行（内容早已转义）
    if (fence !== null) {
      if (/^```/.test(line)) {
        blocks.push(`<pre><code>${fence.join('\n')}</code></pre>`);
        fence = null;
      } else {
        fence.push(line);
      }
      continue;
    }
    if (/^```/.test(line)) {
      flushAll();
      fence = [];
      continue;
    }

    if (line.trim() === '') {
      flushAll();
      continue;
    }

    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    if (heading) {
      flushAll();
      const text = heading[1] ?? '';
      blocks.push(`<h4>${renderInline(text)}</h4>`);
      continue;
    }

    const li = /^[-*]\s+(.+)$/.exec(line);
    if (li) {
      flushPara();
      const text = li[1] ?? '';
      list.push(text);
      continue;
    }

    // 普通文本行：正在积累列表时则结束列表
    flushList();
    para.push(line);
  }
  if (fence !== null && fence.length > 0) blocks.push(`<pre><code>${fence.join('\n')}</code></pre>`);
  flushAll();

  return blocks.join('\n');
}
