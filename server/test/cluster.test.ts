import { describe, expect, it } from 'vitest';
import { CLUSTER_THRESHOLD, clusterIdeas, terms } from '../src/ideas/cluster.js';

const idea = (id: string, title: string, extra: Partial<{ keywords: string[]; focus: string }> = {}) => ({
  id,
  title,
  ...extra,
});

describe('选题聚类', () => {
  it('同一方向的两种写法归为一簇，无关方向各自成簇', () => {
    const clusters = clusterIdeas([
      idea('a', '一种面向GPU-NPU阶段分离推理的KV缓存敏感度分级传输方法', {
        keywords: ['KV缓存', '敏感度分级'],
      }),
      idea('b', '一种KV缓存敏感度分级与草稿联动重建的跨设备传输方法', {
        keywords: ['KV缓存', '敏感度分级'],
      }),
      idea('c', '一种推理请求批处理的动态批大小调度方法', { keywords: ['批处理', '调度'] }),
    ]);
    expect(clusters).toHaveLength(2);
    const big = clusters[0] as (typeof clusters)[number];
    expect(big.ideas.map((i) => i.id).sort()).toEqual(['a', 'b']);
    expect(big.sharedTerms.length).toBeGreaterThan(0);
    expect(clusters[1]?.ideas.map((i) => i.id)).toEqual(['c']);
  });

  it('簇 id 稳定：成员顺序不影响 id（同一批选题重算不会抖动）', () => {
    const x = clusterIdeas([
      idea('a', '一种KV缓存敏感度分级传输方法', { keywords: ['KV缓存'] }),
      idea('b', '一种KV缓存敏感度分级重建方法', { keywords: ['KV缓存'] }),
    ]);
    const y = clusterIdeas([
      idea('b', '一种KV缓存敏感度分级重建方法', { keywords: ['KV缓存'] }),
      idea('a', '一种KV缓存敏感度分级传输方法', { keywords: ['KV缓存'] }),
    ]);
    expect(x[0]?.id).toBe(y[0]?.id);
  });

  it('label 用簇内共享词，解释「凭什么归一类」', () => {
    const [cluster] = clusterIdeas([
      idea('a', '一种投机解码草稿模型长度调度方法', { keywords: ['投机解码', '草稿模型'] }),
      idea('b', '一种投机解码草稿模型长度预测方法', { keywords: ['投机解码', '草稿模型'] }),
    ]);
    expect(cluster?.label).toContain('投机解码');
    expect(cluster?.sharedTerms.length).toBeGreaterThanOrEqual(2);
  });

  it('停用词不参与相似度（否则所有标题都因「一种…方法」而相像）', () => {
    const grams = terms('一种方法');
    expect(grams).toHaveLength(0);
    const clusters = clusterIdeas([
      idea('a', '一种图像超分方法'),
      idea('b', '一种数据库索引方法'),
    ]);
    expect(clusters).toHaveLength(2);
  });

  it('阈值是导出的常量，UI 文案与测试共用同一份口径', () => {
    expect(CLUSTER_THRESHOLD).toBeGreaterThan(0.15);
    expect(CLUSTER_THRESHOLD).toBeLessThan(0.4);
  });

  it('空输入返回空数组（不抛错）', () => {
    expect(clusterIdeas([])).toEqual([]);
  });

  it('大簇排在前面，便于先处理"重复劳动"风险最高的方向', () => {
    const clusters = clusterIdeas([
      idea('solo', '一种分布式训练梯度压缩方法', { keywords: ['梯度压缩'] }),
      idea('a', '一种投机解码接受率预测方法', { keywords: ['投机解码', '接受率'] }),
      idea('b', '一种投机解码接受率估计方法', { keywords: ['投机解码', '接受率'] }),
      idea('c', '一种投机解码接受率校准方法', { keywords: ['投机解码', '接受率'] }),
    ]);
    expect(clusters[0]?.ideas).toHaveLength(3);
    expect(clusters.at(-1)?.ideas).toHaveLength(1);
  });
});
