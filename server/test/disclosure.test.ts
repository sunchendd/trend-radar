import { describe, expect, it } from 'vitest';
import { disclosureFilename, toDisclosureMarkdown } from '../src/ideas/disclosure.js';
import type { Idea, NoveltyRecord } from '../src/types.js';

const NOW = '2026-10-29T00:00:00.000Z';

function makeIdea(overrides: Partial<Idea> = {}): Idea {
  return {
    id: 'idea-test-1',
    createdAt: NOW,
    updatedAt: NOW,
    title: '一种面向GPU-NPU阶段分离推理的KV缓存分级传输与重建方法',
    problem: '阶段分离架构中KV缓存按固定粒度整体传输，未区分层与注意力头的扰动敏感性，导致解码侧长时间空转。',
    solution:
      '离线按扰动实验标定各层KV敏感度并划分为三个等级；预填充端按等级生成块级传输清单；解码端按等级选择精确重建或量化重建；传输与解码流水重叠调度。',
    effect: '跨设备KV传输字节数降低不低于50%，端到端解码吞吐提升不低于15%。',
    keywords: ['KV缓存', '投机解码', '阶段分离'],
    ipcHints: ['G06F12/0871', 'G06F9/50'],
    queries: ['KV缓存 异构 分级 传输 重建'],
    risks: ['HAWK 的异构感知KV传输调度'],
    status: 'verified',
    cites: ['item-1'],
    focus: 'PD 分离 GPU-NPU',
    novelty: [],
    ...overrides,
  };
}

const record = (hits: number | null, query: string, apps = ''): NoveltyRecord => ({
  at: NOW,
  query,
  hits,
  topAssignees: apps,
  note: '测试记录',
  site: 'zhihuiya',
});

describe('专利交底书导出', () => {
  it('包含国内实务习惯的九个章节，且顺序正确', () => {
    const md = toDisclosureMarkdown(makeIdea(), { now: NOW });
    const headings = [
      '## 一、发明名称',
      '## 二、技术领域',
      '## 三、背景技术与现有技术缺陷',
      '## 四、发明内容',
      '## 五、附图说明',
      '## 六、具体实施方式',
      '## 七、检索与查新记录',
      '## 八、建议 IPC 分类号',
      '## 九、参考资料（情报来源）',
    ];
    let cursor = -1;
    for (const heading of headings) {
      const at = md.indexOf(heading);
      expect(at, `缺少章节 ${heading}`).toBeGreaterThan(-1);
      expect(at, `章节顺序错乱：${heading}`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it('把技术方案拆成编号技术特征，而不是整段贴进去', () => {
    const md = toDisclosureMarkdown(makeIdea(), { now: NOW });
    // solution 里有 4 个分句 → 应产生 1..4 编号
    expect(md).toContain('1. 离线按扰动实验标定各层KV敏感度并划分为三个等级');
    expect(md).toContain('4. 传输与解码流水重叠调度');
  });

  it('没有查新记录时明确告警，而不是假装查过', () => {
    const md = toDisclosureMarkdown(makeIdea({ novelty: [] }), { now: NOW });
    expect(md).toContain('本选题尚未查新');
    expect(md).toContain('不具备可专利性判断依据');
    // 章节标题不能因为没数据就消失
    expect(md).toContain('## 七、检索与查新记录');
  });

  it('查新表格区分「零命中」与「解析失败」——这两者混了会误导立项', () => {
    const md = toDisclosureMarkdown(
      makeIdea({
        novelty: [record(0, '草稿模型 KV 缺失 重建 预测'), record(null, '投机解码 异构 KV 重建'), record(9, '投机解码 草稿 KV 压缩', '华为:2')],
      }),
      { now: NOW },
    );
    expect(md).toContain('0（零命中）');
    expect(md).toContain('解析失败');
    expect(md).toContain('| 9 |');
    expect(md).toContain('华为:2');
    // 关键提醒必须出现，否则交底书会被当成"零命中=空白"的证据
    expect(md).toContain('不能**直接认定技术空白');
  });

  it('转义竖线，避免备注里的 | 把表格列串了', () => {
    const md = toDisclosureMarkdown(
      makeIdea({ novelty: [record(3, 'A | B', 'X|Y')] }),
      { now: NOW },
    );
    expect(md).toContain('A \\| B');
    expect(md).toContain('X\\|Y');
  });

  it('缺字段的地方写「待补」，不编造实验数据与附图', () => {
    const md = toDisclosureMarkdown(
      makeIdea({ effect: '', risks: [], ipcHints: [], keywords: [] }),
      { now: NOW },
    );
    expect(md).toContain('（待补）');
    expect(md).toContain('图 1：（待补）');
    // 不能凭空出现具体数值结论
    expect(md).not.toContain('降低不低于50%');
  });

  it('带回判读口径与引用条目（含相关度）', () => {
    const md = toDisclosureMarkdown(makeIdea(), {
      now: NOW,
      verdictHeadline: '稀疏交叉带：4 命中',
      cites: [{ title: 'HAWK: Heterogeneity-Aware KV Cache Transfer', url: 'https://arxiv.org/abs/2610.29873', score: 88 }],
    });
    expect(md).toContain('**当前判读**：稀疏交叉带：4 命中');
    expect(md).toContain('[HAWK: Heterogeneity-Aware KV Cache Transfer](https://arxiv.org/abs/2610.29873)');
    expect(md).toContain('相关度 88');
  });

  it('文件名去掉非法字符并保留中文', () => {
    const name = disclosureFilename(makeIdea({ title: '一种 A/B 测试：含:非法*字符?' }));
    expect(name.endsWith('.md')).toBe(true);
    expect(name).not.toMatch(/[\\/:*?"<>|\s]/);
    expect(name).toContain('一种');
  });
});
