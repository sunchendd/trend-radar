/**
 * 新闻页：只收 `kinds=news,release`。
 *
 * GitHub Releases 在库里是 `release`、博客是 `news`，但对用户是同一件事：
 * **工程信号**——实现细节往往比论文更早出现在 release note 里。
 * 所以这一页把两类合起来看，而论文页只看 paper。
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
