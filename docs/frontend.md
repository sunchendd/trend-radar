# 前端交付说明（web/）

> 本文件是给评审/README 取材用的：文件清单、自测清单、截图出处。
> 契约来源：`docs/api.md` + `server/src/types.ts`（`web/src/lib/types.ts` 逐字同步，带同步头注释）。

## 一遍能跑起来

```bash
npm run dev:server          # 后端 :8787（生产还同源托管 web/dist）
npm run dev:web             # 前端 :5273（/api 由 vite 代理到 8787）
npm run build --workspace web && npm run typecheck --workspace web
```

## 文件清单（25 个源文件 / ~7.6k 行，全部在 `web/src`）

| 目录 | 文件 | 职责 |
| --- | --- | --- |
| `src/` | `App.tsx` | 三段路由外壳、SSE 订阅（`/api/events` → `live.nonce` / `live.idea`）、全局快捷键 `1/2/3` `/` `?`、演示数据横幅 |
| | `main.tsx` · `index.css` | 挂载；整套设计令牌（`@theme` 三层底色 + 墨色三级 + 青绿主色 + 状态色）与组件类 |
| `src/lib/` | `types.ts` | 与 `server/src/types.ts` 同步（含 `VerdictSummary` / `IdeaWithVerdict`） |
| | `api.ts` | 唯一网络出口：超时、错误映射（`ApiError`）、**后端未启动**判定、DEV 演示数据降级 |
| | `feed.ts` | 多信源筛选 → 逐源请求 → 合并去重排序（API 的 `sourceId` 是单值） |
| | `format.ts` | 时间/数字/打分档位/判读档位（与服务端阈值一致：1–5 稀疏、≥50 红海、全零≠空白）、Markdown 导出 |
| | `hooks.ts` | `useDebouncedValue` `useMediaQuery` `useHashRoute` `useHotkeys` `useStats` `useScoreBands`… |
| | `mock.ts` | 仅 DEV 且请求**真实失败**时启用的演示数据（arXiv 风格真实标题），UI 恒显「演示数据」 |
| `src/components/` | `Nav.tsx` `StatBar.tsx` `ItemCard.tsx` `ItemDrawer.tsx` `FilterPanel.tsx` | 骨架屏外的三大件：导航/统计条/情报卡片与抽屉/筛选面板 |
| | `IdeaDetail.tsx` | 选题详情：三段式正文、判读块（服务端 `verdictSummary`）、建议改词、查新记录与分布条、手工登记 |
| | `charts.tsx` | 手写 SVG：分数环、迷你柱、相关度直方图、**命中数对数分布条**（含稀疏带/红海线） |
| | `primitives.tsx` `Overlay.tsx` `Toast.tsx` `States.tsx` `Skeleton.tsx` `Icon.tsx` | 按钮/胶囊/滑块/抽屉/模态/Toast/空态错态/骨架/图标 |
| `src/pages/` | `FeedPage.tsx` | 情报流：统计、搜索（300ms 防抖）、筛选、流式/分页、详情抽屉、采集与导出 |
| | `IdeasPage.tsx` | 选题工作台：生成表单、列表（判读徽标）、详情、状态流转、窄屏列表↔详情 |
| | `SystemPage.tsx` | 信源与日志：启停/权重/备注/最近错误、运行记录表（可展开错误）、新增信源 |
| `public/` | `favicon.svg` | 雷达标记 |
| `docs/screens/` | `feed.png` `ideas.png` `system.png` | 真数据截图（见下） |

## 截图（真数据，1440 宽）

- `docs/screens/feed.png` —— 情报流：105 条真实 arXiv/Release，`高分 ≥70 = 28 / 待判 31`，分数环、打分理由、关键词。
- `docs/screens/ideas.png` —— 选题工作台：LLM 真实生成的选题 + 4 条查新记录（稀疏 3 / 中间 14 / 零命中 0 / 解析失败 null），
  判读块与「建议这样改检索式」、命中数对数分布条（青绿=稀疏交叉带，红=红海）。
- `docs/screens/system.png` —— 信源与日志：7 个信源权重与备注、一条 `fetch failed` 最近错误、3 次采集运行记录。

## 自测清单（12 项，均已逐条跑过）

1. `npm run build --workspace web` 通过；`npm run typecheck --workspace web` 零报错（strict + `noUncheckedIndexedAccess`）。
2. 无后端打开（静态托管 dist）：不白屏，显示「后端未启动，运行 `npm run dev:server`」+ 重试按钮。
3. DEV 下后端挂掉：自动切演示数据，顶部横幅 + 「演示数据」角标，绝不静默假装真数据。
4. 情报流：105 条真数据渲染；搜索 300ms 防抖（105 → 28）；`/` 聚焦搜索、`g` 切流式/分页、`?` 快捷键帮助。
5. 筛选：多信源、类型、相关度滑块、时间范围、排序；已选条件计数与「清除」；1024–1280 宽时筛选收进抽屉。
6. 分页模式翻页正确（`offset=20` 请求、`2 / 6` 指示）；流式模式「加载更多」追加不重复。
7. 卡片 ↔ 抽屉：点卡片开抽屉（摘要 + 打分明细 + 外部链接），`Escape` 关闭并归还焦点。
8. 选题工作台：判读徽标取服务端 `verdictSummary.headline`；`suggestions` 渲染成「建议这样改检索式」可点击复制。
9. 查新记录：`hits: null` → 琥珀「解析失败 / — 命中数未知」，`hits: 0` → 灰「零命中 · 需改词」，两者都**不**当作技术空白。
10. 手工登记查新后：列表徽标、状态、分布条同步更新；SSE `idea` 帧到达就地更新该条（不整表重载）。
11. 信源页：启停开关乐观更新+失败回滚、权重滑块、备注保存、`最近错误` 条、运行记录展开错误、新增信源 422 提示。
12. 响应式：≥1280 三列（列表+详情+筛选并排）；390 宽单列 + 底部 Tab，选题页先看列表再进详情（`‹ 列表` 返回）。


## 巡检 → 选题闭环（2026-10 增补）

- 路由：`#/watch`（巡检页）；从巡检页「出选题」跳到 `#/ideas?idea=<id>`，工作台按 query 参数**直选**该条。
- `WatchPage` 只呈现后端 `ideas/trend.ts` 的判读结果（档位阈值不在前端复制一份）。
- 折线图手写 SVG：命中数为 `null`（解析失败）画**空心方块**、0 命中是贴底实心点——两者语义不同，视觉上不能混。
- 生成失败按 code 分流文案：`llm_not_configured` → "填 LLM_BASE_URL / LLM_MODEL 后可用；也可手工新建"，其余走通用错误。
