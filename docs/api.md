# trend-radar HTTP API (v1)

Base: `http://127.0.0.1:8787`，全部 `Content-Type: application/json`（SSE 除外）。
错误统一：`{ "error": { "code": "...", "message": "...", "detail"?: any } }`，HTTP 状态码语义化。
类型定义见 `server/src/types.ts`（**冻结契约**）。

## 只读

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | `{ ok: true, version, uptimeSec }`，用于探活/部署检查 |
| GET | `/api/stats` | `Stats`：条目数、选题数、源数量、最近一次采集、近 7 天每日新增、相关度直方图 |
| GET | `/api/items?kinds=news,release` | 同单值 `kind`，`kinds` 为逗号分隔多选（论文页 `kind=paper`，新闻页 `kinds=news,release`）；非法值 400 |
| GET | `/api/items` | 分页查询条目，参数见下，返回 `Paged<Item>` |
| GET | `/api/items/:id` | 单条详情 `Item`，404 时走错误格式 |
| GET | `/api/sources` | `Source[]`，含 `enabled`/`weight`/`note` |
| GET | `/api/ideas/clusters?status=` | — | 选题按技术方向聚类：`[{id,label,sharedTerms,size,ideaIds,titles}]`（阈值 0.22，见 `ideas/cluster.ts`） |
| GET | `/api/ideas` | `Idea[]`，按 `updatedAt` 倒序；`?status=` 可过滤 |
| GET | `/api/ideas/:id` | 单条选题 `Idea` |
| GET | `/api/settings` | — | 运行时设置：`dailyRefreshAt`/`dailyRefreshEnabled`/`collectMinutes`/`limitPerSource`/`minKeepScore`/`ttlDays`/`highScore`/`midScore`/`llm{baseUrl,model,hasApiKey}`/`novelty{command,hasCommand}`/`updatedAt`/`nextRefreshAt`/`refreshMode`。**API Key 永不回传明文**，只给 `hasApiKey` |
| PUT | `/api/settings` | `AppSettingsPatch` | 只改传了的字段；`llm.apiKey` 传空串 = 不改；保存后**立即重排定时器**（无需重启）。`dailyRefreshAt` 非 `HH:mm`、`midScore>highScore`、`ttlDays` 越界 → 400 `validation_error`（`detail.fields[]` 指明字段） |
| GET | `/api/runs?limit=20` | 最近运行记录；`perSource` 为每源 `{sourceId,ms,items,error?}`（v2 起；老记录无此字段） |
| GET | `/api/export?format=csv\|json` | 导出条目（csv 列：score,kind,title,url,sourceId,publishedAt） |
| GET | `/api/ideas/:id/disclosure?format=md\|docx` | 导出该选题的**专利交底书**（默认 md 走 `text/markdown`；`docx` 走 OOXML；均为 attachment，九章结构；查新记录如实转录，`0（零命中）` 与 `解析失败` 分开标注） |

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

### 论文阅读器（PDF 下载 / 高亮笔记 / 选中文本提问）

| 方法 | 路径 | body | 说明 |
|---|---|---|---|
| POST | `/api/items/:id/paper` | — | **自动下载论文 PDF**（幂等，在飞请求复用同一个 Promise）。返回 `PaperInfo {itemId,status:'ready'\|'failed',originUrl,bytes,error,downloadedAt,updatedAt}`。来源解析：arXiv externalId/url → `arxiv.org/pdf/<id>`；`.pdf` 直链（含 OpenReview `/pdf?id=`）；Google Patents 页面解析 patentimages 链接。魔数 `%PDF` 校验，单文件上限 64MB，失败如实写 `status:'failed' + error` |
| GET | `/api/items/:id/paper` | — | 下载状态查询（阅读器进度轮询用）；进程重启遗留的僵尸 `pending` 自动改判 `failed`（可重试） |
| GET | `/api/items/:id/paper/file` | — | PDF 原文流（`application/pdf`，inline）；未下载/已失效 404。文件存于 `<dataDir>/papers/<itemId>.pdf`，TTL 清条目时连带回收 |
| GET | `/api/items/:id/annotations` | — | `PaperAnnotation[] {id,itemId,page,rects:[{x,y,w,h}],text,note,color,createdAt,updatedAt}`；rects 归一化到页面（0–1），缩放不变 |
| POST | `/api/items/:id/annotations` | `{page,rects,text?,note?,color?}` | 新增高亮/笔记，201；`color` 限 `#f2b357 #35e7c5 #7aa7f7 #ff8fa3 #c3a6ff`；rect 非法 400 |
| PATCH | `/api/items/:id/annotations/:aid` | `{note?,color?}` | 改笔记/换色；404 时表示标注不存在或不属于该条目 |
| DELETE | `/api/items/:id/annotations/:aid` | — | 删除标注 |
| POST | `/api/items/:id/paper/ask` | `{question,page?,pageText?,selection?,history?}` | **选中文本提问**（SSE，帧契约与 `/api/chat` 相同：status/token/done/error）。上下文 = 当前页全文 + 选中文本，不落库；与 chat 共用并发闸（2），超限 429 `chat_busy`；LLM 未配置 503 |

## 实时

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/events` | SSE；事件 `run`(采集完成)、`items`(新增条目数)、`idea`(选题变更)，data 为对应 JSON |

## 对话（自然语言检索 / 论文 / 专利 / 选题）

| 方法 | 路径 | body | 说明 |
|---|---|---|---|
| POST | `/api/chat` | `{ message: string(1–2000), history?: {role,content}[](≤12) }` | **SSE 流式**对话（`text/event-stream`）；LLM 决策循环 ≤4 轮，四工具：`search_local`(库内) / `search_arxiv`(实时) / `search_patents`(Google Patents) / `generate_ideas`(落库) |

成功时逐帧推送（`event: <name>\ndata: <json>\n\n`）：

| 事件 | data | 次数 |
|---|---|---|
| `status` | `{ step, label }`，step ∈ plan/search_local/search_arxiv/search_patents/generate_ideas/compose | 多次（前端进度行） |
| `sources` | `{ items: [{title, url, kind, meta}] }`，kind ∈ paper/news/release/patent/idea | 多次，**覆盖式**（前端整表替换、按 url 去重编号） |
| `token` | `{ text }` 回答增量 | 多次 |
| `done` | `{ messageId, toolsUsed[] }` | 恰好一次，随后连接关闭 |
| `error` | `{ code, message }` | 中途失败时一次，随后关闭 |

校验失败 / 前置失败走**普通 JSON 错误**（`content-type: application/json`，前端按 content-type 区分）：
`400 validation_error`；LLM 未配置 `503 llm_not_configured`；生成/合成失败 `502 llm_bad_output`；
并发在飞 >2 时 `429 chat_busy`。客户端断开即取消后端生成（合成流随时掐断，决策轮在轮间边界检查）。

### 对话会话持久化

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/chat` | body 可带 `sessionId`（`/^[A-Za-z0-9_-]{8,64}$/`）：有则服务端取该会话最近 12 条当 history（忽略请求 history）、user 即时落库、done 前 assistant 落库；无则兼容旧模式不落库。done 帧带 `sessionId` |
| GET | `/api/chat/sessions` | 最近 20 个会话：`[{sessionId, title(首条用户消息≤40字), lastAt, messageCount}]` |
| GET | `/api/chat/sessions/:id` | `{sessionId, messages: [{role, content, toolsUsed?, sources?, at}]}`，上限 200 条 |
| DELETE | `/api/chat/sessions/:id` | 删除会话，`{ok:true}` |

### 对话新工具（R2）

| 工具 | 参数 | 说明 |
|---|---|---|
| `export_disclosure` | `{ideaId, format?: 'md'\|'docx'}` | 返回交底书下载链接（`/api/ideas/:id/disclosure`） |
| `check_novelty` | `{ideaId}` | 智慧芽 CLI 已配置→真查新并落库；否则摘要已有查新记录判读；两者皆无→引导配置/手动登记 |
| `draft_claims` | `{ideaId}` | 基于选题 problem/solution/effect 生成独立权利要求 1 条 + 从属 3–5 条，落库并在对话中返回 |

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/ideas/:id/claims` | 最近一次权利要求草案 `{content, at}`；无则 404 |

### 巡检引擎（R2）

- `POST /api/watches` body 增加可选 `engine`：`zhihuiya`（默认）| `google_patents`（兼容连字符写法 `google-patents`，入口规范化）
- `google_patents` 引擎不走智慧芽 CLI：用 Google Patents 免鉴权接口跑命中数 + Top5 快照，query 原样透传
  （可尝试 `assignee:公司名` 过滤，**实验性**——GP 对该字段组合语义多变，建议先用纯关键词验证命中量再收窄）；
  请求失败进 `errors`，**绝不把失败记成 0 命中**
- `listWatches` 返回带 `engine` 与 `lastSnapshot: {at?, count?, topTitles?: string[]}`

### Bark 推送（R2，可选）

- 配置：env `BARK_URL`（形如 `https://api.day.app/<key>`）或设置页（`PUT /api/settings` 的 `bark: {url?, enabled?}`，url 空串=清除）
- 定时采集完成后自动推日报（近 24h 高分 Top5 + 新增选题数）；未配置/禁用静默跳过；失败仅记日志
- `POST /api/push/test`：body `{}`（测已保存配置）或 `{url}`（先测后存场景）

## 约定

1. **不要**在响应里塞内部字段（sqlite rowid、原始 SQL 错误栈）。
2. 所有时间为 ISO 8601 UTC 字符串。
3. `hits: null` 表示「页面解析失败」，`hits: 0` 表示「确实没有命中」——两者语义不同，前端必须区分展示。
4. 采集端点幂等：同一秒内重复触发直接复用进行中的那次采集，返回同一个 `RunRecord`。
