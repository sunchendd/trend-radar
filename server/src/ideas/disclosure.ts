/**
 * 专利交底书导出（纯函数，无 IO）
 *
 * 为什么要有这个文件：产品走到「选题已验证」之后，用户下一步是把它写成交底书交给代理人。
 * 之前的「复制 Markdown」只是把选题字段拼起来，缺交底书应有的章节（技术领域、背景缺陷、
 * 附图说明、具体实施方式、区别特征），代理人和发明人都不好用。
 *
 * 这里只做**结构**和**如实转录**：不编造实验数据、不编造附图，没有的信息就写「待补」，
 * 让缺什么一目了然。查新记录必须原样带出来（含 null=解析失败 / 0=零命中 的区别），
 * 否则交底书会给人一种"从没查过"的错觉。
 */
import type { Idea, NoveltyRecord } from '../types.js';

export interface DisclosureOptions {
  /** 判读摘要（由 ideas/verdict.ts 生成，路由层传入；缺失时退化为不写结论） */
  verdictHeadline?: string;
  /** 引用条目的可读标题，用于末尾「参考资料」 */
  cites?: { title: string; url: string; score?: number }[];
  /** 生成时间（ISO），测试里可注入固定值 */
  now?: string;
}

const TODO = '（待补）';

/** 中文序号，最多到十（交底书不会超过这个层级） */
const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

/** 把长段方案拆成可编号的技术特征：按句号/分号切，太短的不切 */
function splitFeatures(text: string): string[] {
  return text
    .split(/[。；;]\s*/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 8);
}

/** Markdown 表格里必须转义竖线，否则列会串 */
const cell = (value: string): string => value.replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim() || '—';

/** 命中数的三种语义必须分开展示：null=解析失败、0=零命中、其余为实数 */
function hitsText(hits: number | null): string {
  if (hits === null) return '解析失败';
  if (hits === 0) return '0（零命中）';
  return String(hits);
}

function noveltySection(records: NoveltyRecord[]): string {
  // 章节号必须恒定存在：交底书章节缺失会让代理人以为漏了内容
  if (records.length === 0) {
    return [
      '## 七、检索与查新记录',
      '',
      '> ⚠️ 本选题尚未查新。未登记任何命中数时，交底书**不具备可专利性判断依据**，',
      '> 请先跑 `/api/ideas/{id}/novelty/auto` 或手工登记命中数，再导出交底书。',
      '',
    ].join('\n');
  }
  const rows = records
    .map((r) => `| ${cell(r.query)} | ${cell(hitsText(r.hits))} | ${cell(r.topAssignees)} | ${cell(r.note)} |`)
    .join('\n');
  return [
    '## 七、检索与查新记录',
    '',
    '| 检索式 | 命中数 | 头部申请人 | 备注 |',
    '| --- | --- | --- | --- |',
    rows,
    '',
    '> 命中数 `0（零命中）` 与 `解析失败` 不是一回事：前者是检索式真的没查到，后者是页面没解析出来。',
    '> 单一检索式零命中**不能**直接认定技术空白（中文专利简单检索是 AND 语义，词越多越容易为 0）。',
    '',
  ].join('\n');
}

/**
 * 生成交底书 Markdown。
 * 章节顺序按国内实务习惯：名称 → 领域 → 背景 → 发明内容 → 附图 → 实施方式 → 区别特征 → 查新 → IPC。
 */
export function toDisclosureMarkdown(idea: Idea, options: DisclosureOptions = {}): string {
  const stamp = options.now ?? new Date().toISOString();
  const features = splitFeatures(idea.solution);
  const lines: string[] = [];

  lines.push(`# 专利交底书：${idea.title}`, '');
  lines.push(`> 由 trend-radar 根据选题 \`${idea.id}\` 生成于 ${stamp}`, '');
  lines.push(`> 技术焦点：${idea.focus || TODO}`, '');
  if (idea.promptVersion) lines.push(`> 选题生成口径：${idea.promptVersion}`, '');
  lines.push('');

  // 一、名称
  lines.push('## 一、发明名称', '', idea.title || TODO, '');

  // 二、技术领域
  lines.push(
    '## 二、技术领域',
    '',
    `本发明涉及 ${idea.keywords.length > 0 ? idea.keywords.join('、') : TODO} 技术领域，`,
    `具体涉及一种${idea.title.replace(/^一种/, '')}。`,
    '',
  );

  // 三、背景技术
  lines.push(
    '## 三、背景技术与现有技术缺陷',
    '',
    idea.problem || TODO,
    '',
    '现有技术未给出上述情形下的处理手段，因此存在本交底书所述的技术问题。',
    '',
  );

  // 四、发明内容
  lines.push('## 四、发明内容', '', '### 4.1 技术方案', '');
  if (features.length === 0) {
    lines.push(idea.solution || TODO, '');
  } else {
    lines.push('本发明采用如下相互配合的技术手段：', '');
    features.forEach((feature, index) => lines.push(`${index + 1}. ${feature}。`));
    lines.push('');
  }
  lines.push('### 4.2 有益效果', '', idea.effect || TODO, '');

  // 五、附图说明（不编造，只给占位与建议）
  lines.push(
    '## 五、附图说明',
    '',
    `图 1：${TODO}整体架构示意图（标出各模块与数据流方向）`,
    '',
    `图 2：${TODO}关键流程时序图（按技术方案的步骤编号对应）`,
    '',
  );

  // 六、具体实施方式
  lines.push(
    '## 六、具体实施方式',
    '',
    '### 6.1 系统组成',
    '',
    '按图 1，本实施例包括以下模块：' + (features.length > 0 ? '（与技术方案的各技术手段一一对应）' : TODO),
    '',
    ...features.map((feature, index) => `- 模块 ${index + 1}：实现「${feature}」`),
    '',
    '### 6.2 关键参数与阈值',
    '',
    `- 触发阈值、分组数量、压缩率、回退条件等具体取值：${TODO}（需实测数据支撑）`,
    '',
    '### 6.3 与现有方案的区别',
    '',
    ...(idea.risks.length > 0
      ? idea.risks.map((risk, index) => `- 区别点 ${index + 1}：相对于「${risk}」，本方案的区别技术特征为：${TODO}`)
      : [`- ${TODO}`]),
    '',
  );

  // 七、查新
  lines.push(noveltySection(idea.novelty));
  if (options.verdictHeadline) {
    lines.push(`**当前判读**：${options.verdictHeadline}`, '');
  }

  // 八、IPC
  lines.push(
    '## 八、建议 IPC 分类号',
    '',
    ...(idea.ipcHints.length > 0 ? idea.ipcHints.map((hint) => `- ${hint}`) : [`- ${TODO}`]),
    '',
  );

  // 九、参考资料
  const cites = options.cites ?? [];
  lines.push('## 九、参考资料（情报来源）', '');
  if (cites.length > 0) {
    cites.forEach((cite, index) => {
      const score = typeof cite.score === 'number' ? `（相关度 ${cite.score}）` : '';
      lines.push(`${index + 1}. [${cite.title}](${cite.url}) ${score}`.trim());
    });
  } else {
    lines.push(`- ${TODO}`);
  }
  lines.push('');

  return lines.join('\n');
}

/** 文件名：保留中文但去掉路径分隔符与空白，避免下载时变成乱码或非法名 */
export function disclosureFilename(idea: Idea): string {
  const safe = idea.title.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || idea.id;
  return `交底书_${safe}.md`;
}

export const CN_SECTION_NUMBERS = CN_NUM;
