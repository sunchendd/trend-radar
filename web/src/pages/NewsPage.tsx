/**
 * 新闻页：只收 `kinds=news`（RSS 新闻 + 技术博客，含 flashinfer）。
 *
 * GitHub Releases（kind=release）自 t19 起在**查询层**排除：数据源保留、照常打分入库，
 * 但不再混进新闻页——独立展示由「工程动态」页承载（t21）。
 * 新闻页的口径是「行业在发生什么」：41 个 daily-newsletter RSS 源 + flashinfer 博客。
 */
import type { JSX } from 'react';
import { FeedPage } from './FeedPage';
import type { Route } from '../lib/hooks';

export function NewsPage({
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
  return <FeedPage route={route} scope="news" demo={demo} liveNonce={liveNonce} onHelp={onHelp} />;
}
