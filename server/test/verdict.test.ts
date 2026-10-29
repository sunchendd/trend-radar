import { describe, expect, it } from 'vitest';

import type { NoveltyRecord } from '../src/types.js';
import {
  RED_OCEAN_HITS,
  SPARSE_HITS_MAX,
  statusOf,
  summarizeVerdict,
  verdict,
} from '../src/ideas/verdict.js';

const at = '2026-10-29T12:00:00.000Z';

const rec = (query: string, hits: number | null, topAssignees = ''): NoveltyRecord => ({
  at,
  query,
  hits,
  topAssignees,
  note: '自动查新（智慧芽）',
  site: 'zhihuiya',
});

describe('verdict：查新判读（机械规则）', () => {
  it('全部 hits=null → inconclusive（页面解析失败，不是空位）', () => {
    const outcome = verdict([rec('投机解码 草稿 置信度', null), rec('草稿模型 接受率 动态', null)]);

    expect(outcome.verdict).toBe('inconclusive');
    expect(outcome.status).toBe('draft');
    expect(outcome.reason).not.toBe('');
    expect(outcome.reason).toContain('解析失败');
    // 关键数字：null 的条数要出现，方便运维对账
    expect(outcome.reason).toMatch(/\b2 条/);
    expect(outcome.reason).toMatch(/null/);
  });

  it('全部为 0 → inconclusive，理由必须要求先怀疑检索式（不能判技术空白）', () => {
    const outcome = verdict([
      rec('投机解码 草稿 置信度 退出', 0),
      rec('草稿模型 接受率 动态 调整', 0),
      rec('解码 缓存 命中 分级 调度', 0),
    ]);

    expect(outcome.verdict).toBe('inconclusive');
    expect(outcome.status).toBe('draft');
    expect(outcome.reason).toContain('先怀疑检索式/术语，再谈空白');
    expect(outcome.reason).toContain('AND');
    expect(outcome.reason).toContain('不得据此判定技术空白');
    // 数字：三条 0 都要露出来，避免「看起来像说了一堆」
    expect(outcome.reason).toContain('[0, 0, 0]');
  });

  it('存在 1–5 命中且无红海 → opportunity（稀疏交叉带）', () => {
    const outcome = verdict([
      rec('投机解码 草稿 置信度 退出', 0),
      rec('草稿模型 接受率 动态 调整', 3, '华为技术有限公司:2、中国电信:1'),
      rec('解码 缓存 命中 分级 调度', 2),
    ]);

    expect(outcome.verdict).toBe('opportunity');
    expect(outcome.status).toBe('verified');
    expect(outcome.reason).toContain('稀疏交叉带');
    expect(outcome.reason).toContain('草稿模型 接受率 动态 调整');
    expect(outcome.reason).toContain('命中 3');
    expect(outcome.reason).toContain('华为技术有限公司');
    expect(outcome.reason).toContain(`1–${SPARSE_HITS_MAX}`);
  });

  it('存在 ≥50 命中 → red-ocean，reason 带检索式与头部申请人', () => {
    const outcome = verdict([
      rec('投机解码 草稿 置信度 退出', 128, '腾讯科技（深圳）有限公司:21、华为技术有限公司:17'),
      rec('草稿模型 接受率 动态 调整', 2),
    ]);

    expect(outcome.verdict).toBe('red-ocean');
    expect(outcome.status).toBe('red-ocean');
    expect(outcome.reason).toContain('红海');
    expect(outcome.reason).toContain('投机解码 草稿 置信度 退出');
    expect(outcome.reason).toContain('128');
    expect(outcome.reason).toContain(String(RED_OCEAN_HITS));
    expect(outcome.reason).toContain('腾讯科技（深圳）有限公司');
  });

  it('只有 6–49 的中间值 → opportunity，reason 要求读最近邻权利要求', () => {
    const outcome = verdict([rec('投机解码 草稿 置信度 退出', 12), rec('草稿模型 接受率 动态 调整', 7)]);

    expect(outcome.verdict).toBe('opportunity');
    expect(outcome.status).toBe('verified');
    expect(outcome.reason).toContain('需读最近邻权利要求');
    expect(outcome.reason).toContain('[12, 7]');
    expect(outcome.reason).toContain(`6–${RED_OCEAN_HITS - 1}`);
  });

  it('没有任何记录 → inconclusive（没查 ≠ 没专利）', () => {
    const outcome = verdict([]);

    expect(outcome.verdict).toBe('inconclusive');
    expect(outcome.status).toBe('draft');
    expect(outcome.reason).toContain('0 条');
  });

  it('部分解析失败 + 其余全零 → 仍按 inconclusive，并说明有几条没取到数', () => {
    const outcome = verdict([rec('投机解码 草稿 置信度 退出', 0), rec('草稿模型 接受率 动态 调整', null)]);

    expect(outcome.verdict).toBe('inconclusive');
    expect(outcome.status).toBe('draft');
    expect(outcome.reason).toContain('另有 1 条');
  });

  it('任何输入都不会机械产出 gap（技术空白只能人工确认）', () => {
    const inputs: NoveltyRecord[][] = [
      [],
      [rec('a b c', null)],
      [rec('a b c', 0)],
      [rec('a b c', 3)],
      [rec('a b c', 9)],
      [rec('a b c', 99)],
      [rec('a b c', 0), rec('d e f', 4)],
    ];

    expect(inputs.map((records) => verdict(records).verdict)).not.toContain('gap');
    expect(statusOf('gap')).toBe('verified'); // 人工确认 gap 时的映射仍然一致
  });
});

describe('summarizeVerdict：UI 徽标 / 证据表 / 可执行建议', () => {
  it('红海：headline 带头部申请人与命中数，建议点名该申请人', () => {
    const summary = summarizeVerdict([
      rec('投机解码 草稿 置信度 退出', 128, '华为技术有限公司:21、腾讯科技（深圳）有限公司:17'),
      rec('草稿模型 接受率 动态 调整', 2),
    ]);

    expect(summary.verdict).toBe('red-ocean');
    expect(summary.headline).toContain('红海');
    expect(summary.headline).toContain('华为技术有限公司');
    expect(summary.headline).toContain('128');
    expect(summary.headline.length).toBeLessThanOrEqual(24);
    expect(summary.suggestions.length).toBeGreaterThan(0);
    expect(summary.suggestions[0]).toContain('华为技术有限公司');
    expect(summary.evidence).toHaveLength(2);
    expect(summary.evidence[0]).toEqual({
      query: '投机解码 草稿 置信度 退出',
      hits: 128,
      topAssignees: '华为技术有限公司:21、腾讯科技（深圳）有限公司:17',
    });
  });

  it('稀疏交叉带：headline 直接是「稀疏交叉带：3 命中」', () => {
    const summary = summarizeVerdict([rec('投机解码 草稿 置信度 退出', 0), rec('草稿模型 接受率 动态 调整', 3)]);

    expect(summary.verdict).toBe('opportunity');
    expect(summary.headline).toBe('稀疏交叉带：3 命中');
    expect(summary.suggestions.join('；')).toContain('权利要求');
  });

  it('中间地带：headline 给非零命中区间', () => {
    const summary = summarizeVerdict([rec('投机解码 草稿 置信度 退出', 12), rec('草稿模型 接受率 动态 调整', 7)]);

    expect(summary.headline).toBe('中间地带：7–12 命中');
    expect(summary.suggestions.join('；')).toContain('最近邻权利要求');
  });

  it('全零：headline 说「无法判断」，建议必须是可执行的改词动作（不是「请人工判断」）', () => {
    const summary = summarizeVerdict([
      rec('投机解码 草稿 置信度 重建', 0),
      rec('草稿模型 接受率 动态 调整', 0),
    ]);

    expect(summary.verdict).toBe('inconclusive');
    expect(summary.headline).toBe('无法判断：全部零命中');
    const joined = summary.suggestions.join('；');
    expect(joined).toContain('去掉尾词「重建」后重试');
    expect(joined).toContain('减到 3 个词');
    expect(joined).toContain('AND');
    expect(summary.suggestions.length).toBeGreaterThanOrEqual(3);
  });

  it('全零且检索式含「KV压缩」：建议同义改写（实测换词会显著改变命中数）', () => {
    const summary = summarizeVerdict([rec('KV压缩 分页 块 管理', 0)]);

    expect(summary.headline).toBe('无法判断：全部零命中');
    expect(summary.suggestions.join('；')).toContain('把「KV压缩」换成「KV缓存」');
  });

  it('解析失败 → 建议检查登录态；没有记录 → 建议先查新', () => {
    expect(summarizeVerdict([rec('a b c', null)]).headline).toBe('无法判断：解析失败');
    expect(summarizeVerdict([rec('a b c', null)]).suggestions.join('；')).toContain('登录态');

    const empty = summarizeVerdict([]);
    expect(empty.headline).toBe('未查新：无记录');
    expect(empty.evidence).toEqual([]);
    expect(empty.suggestions.length).toBeGreaterThan(0);
  });

  it('四档 headline 都非空且不超过 24 字（徽标不换行）', () => {
    const cases = [
      [rec('a b c', null)],
      [rec('a b c', 0)],
      [rec('a b c', 3)],
      [rec('a b c', 12)],
      [rec('a b c', 128, '华为技术有限公司:21')],
      [],
    ];

    for (const records of cases) {
      const summary = summarizeVerdict(records);
      expect(summary.headline.trim()).not.toBe('');
      expect(summary.headline.length).toBeLessThanOrEqual(24);
      expect(summary.verdict).not.toBe('gap');
    }
  });
});
