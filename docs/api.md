# trend-radar HTTP API (v1)

Base: `http://127.0.0.1:8787`，全部 `Content-Type: application/json`（SSE 除外）。
错误统一：`{ "error": { "code": "...", "message": "...", "detail"?: any } }`，HTTP 状态码语义化。
类型定义见 `server/src/types.ts`（**冻结契约**）。

## 只读

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | `{ ok: true, version, uptimeSec }`，用于探活/部署检查 |
| GET | `/api/stats` | `Stats`：条目数、选题数、源数量、最近一次采集、近 7 天每日新增、相关度直方图 |
| GET | `/api/items` | 分页查询条目，参数见下，返回 `Paged<Item>` |
| GET | `/api/items/:id` | 单条详情 `Item`，404 时走错误格式 |
| GET | `/api/sources` | `Source[]`，含 `enabled`/`weight`/`note` |
| GET | `/api/ideas` | `Idea[]`，按 `updatedAt` 倒序；`?status=` 可过滤 |
| GET | `/api/ideas/:id` | 单条选题 `Idea` |
| GET | `/api/runs?limit=20` | 最近运行记录；`perSource` 为每源 `{sourceId,ms,items,error?}`（v2 起；老记录无此字段） |
| GET | `/api/export?format=csv\|json` | 导出条目（csv 列：score,kind,title,url,sourceId,publishedAt） |
| GET | `/api/ideas/:id/disclosure` | 导出该选题的**专利交底书 Markdown**（`text/markdown` + attachment，九章结构；查新记录如实转录，`0（零命中）` 与 `解析失败` 分开标注） |

`/api/items` 查询参数（全部可选）：

- `q` 关键词，匹配 title/summary/keywords（不区分大小写）
- `sourceId`、`kind`（paper|news|release）
- `minScore` 0–100
- `since` ISO 日期，过滤 `publishedAt >= since`
- `sort` = `score`（默认）或 `time`
- `limit` 默认 30，最大 200；`offset` 默认 0

## 写操作

| 方法 | 路径 | body | 说明 |
|---|---|---|---|
| POST | `/api/collect` | `{ sourceIds?: string[] }` | 触发一次采集，**同步**返回 `RunRecord`（并发 6、单源上限 20–40 条；**正常 ≤30s**，arXiv 长尾源实测 15–22s，超时源进 `errors` 不影响其余源） |
| PATCH | `/api/sources/:id` | `{ enabled?: boolean, weight?: number, note?: string }` | 启停/调权重；`weight` 限制 0.1–3 |
| POST | `/api/sources` | `{ id, kind, label, url, weight?, tags?, note? }` | 新增源，先探活（HTTP 200 且能解析出条目）再落库，探活失败返回 422 |
| DELETE | `/api/sources/:id` | — | 删除源（条目保留，标为 orphan） |
| GET | `/api/watches?all=true` | — | 巡检方向列表（默认只返回启用的；含最近命中数、巡检次数） |
| POST | `/api/watches` | `{ query, note? }` | 新增巡检方向，201；同检索式去重 |
| PATCH | `/api/watches/:id` | `{ enabled }` | 启停巡检方向 |
| DELETE | `/api/watches/:id` | — | 删除巡检方向（连带快照） |
| POST | `/api/watches/sweep` | — | 跑一轮巡检（调外部查新，20–60s）；单方向失败不中断，**整轮全失败返回 503/500 而不是空结果** |
| POST | `/api/ideas` | `{ title, problem, solution, effect, keywords?, ipcHints?, queries?, risks?, focus? }` | **手工创建**选题（不经过 LLM），201 返回 `IdeaWithVerdict`；IPC 号不合法/字段过短 → 400 |
| POST | `/api/ideas/generate` | `GenerateIdeasRequest` | 调 LLM 生成选题，返回 `{ ideas: Idea[], usedItems: string[], dropped: {title,reasons[]}[] }`；**生成结果会落库**；LLM 未配置返回 503 `code=llm_not_configured` |
| PATCH | `/api/ideas/:id` | `{ status?, title?, problem?, solution?, effect?, queries?, risks? }` | 人工修订 |
| DELETE | `/api/ideas/:id` | — | 归档（软删，status=archived） |
| POST | `/api/ideas/:id/novelty` | `{ query, hits, topAssignees?, note?, site? }` | 手工登记一条查新记录，同时按 `verdict()` 重算 status |
| POST | `/api/ideas/:id/novelty/auto` | `{ queries?: string[] }` | 调智慧芽 CLI 批量查新并写回；未配置返回 503 `code=novelty_not_configured` |

## 实时

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/events` | SSE；事件 `run`(采集完成)、`items`(新增条目数)、`idea`(选题变更)，data 为对应 JSON |

## 约定

1. **不要**在响应里塞内部字段（sqlite rowid、原始 SQL 错误栈）。
2. 所有时间为 ISO 8601 UTC 字符串。
3. `hits: null` 表示「页面解析失败」，`hits: 0` 表示「确实没有命中」——两者语义不同，前端必须区分展示。
4. 采集端点幂等：同一秒内重复触发直接复用进行中的那次采集，返回同一个 `RunRecord`。
