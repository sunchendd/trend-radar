/**
 * 论文页：只收 `kind=paper`（arXiv 等论文源）。
 *
 * 单独成一页而不是给情报流加个 tab：论文和资讯的阅读姿势完全不同——
 * 论文要「先读高分那几篇的摘要」，资讯要「扫一眼今天哪个项目动了」。
 * KPI 也各算各的（见 FeedPage 里 useScopedKpi 的用法）。
 */
import type { JSX } from 'react';
import { FeedPage } from './FeedPage';
import type { Route } from '../lib/hooks';

export function PapersPage({
  route,
  demo,
  liveNonce,
  onHelp,
}: {
  route: Route;
  demo: boolean;
  liveNonce: number;
  onHelp: () => void;
}): JSX.Element {
  return <FeedPage route={route} scope="papers" demo={demo} liveNonce={liveNonce} onHelp={onHelp} />;
}
