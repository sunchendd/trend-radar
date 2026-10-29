import type { Source, SourceKind } from '../types.js';
import { fetchAllSources, type FetchDeps } from './index.js';

/**
 * 新源探活（`POST /api/sources` 落库前必须过这一关）。
 *
 * 为什么复用 fetchAllSources 而不是自己写一遍请求：探活口径必须与真实抓取完全一致，
 * 否则会出现「探活通过但采集永远 0 条」的源——这种源比接口报错更浪费运维时间。
 * 这里只把「单源失败」翻译成异常，因为探活是交互式请求，失败必须立刻反馈给用户。
 */

export interface ProbeInput {
  id: string;
  kind: SourceKind;
  label: string;
  url: string;
  weight?: number;
  tags?: string[];
  note?: string;
}

export interface ProbeResult {
  /** 能解析出的条目数（截断前） */
  sampleCount: number;
  /** 前几条标题，便于前端回显「探活成功，抓到 N 条，例如 …」 */
  sample: { title: string; url: string }[];
}

const PROBE_SAMPLE_LIMIT = 10;

export async function probeSource(input: ProbeInput, deps: FetchDeps = {}): Promise<ProbeResult> {
  const source: Source = {
    id: input.id,
    kind: input.kind,
    label: input.label,
    url: input.url,
    weight: input.weight ?? 1,
    enabled: true,
    tags: input.tags ?? [],
    note: input.note ?? '',
    createdAt: new Date().toISOString(),
  };

  const result = await fetchAllSources(
    { limitPerSource: PROBE_SAMPLE_LIMIT },
    { ...deps, sources: [source], concurrency: 1 },
  );

  const failure = result.errors[0];
  if (failure) {
    throw new Error(`源探活失败（${input.url}）：${failure.message}`);
  }
  if (result.items.length === 0) {
    // 200 但解析不出条目，多半是 feed 结构不认识或关键词订阅太窄——同样不允许入库
    throw new Error(`源探活失败（${input.url}）：响应可访问但解析不出任何条目`);
  }

  return {
    sampleCount: result.items.length,
    sample: result.items.map((item) => ({ title: item.title, url: item.url })),
  };
}
