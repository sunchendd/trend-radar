---
name: trend-radar
description: 技术情报雷达 + 中国发明专利选题生产线。聚合 arXiv / GitHub Releases / RSS 情报源，可解释相关度打分，LLM 生成专利选题，智慧芽查新判读（红海/机会/缺口/存疑四档），检索式巡检预警，一键导出专利交底书（Markdown + Word）。当用户提到"技术情报"、"趋势雷达"、"trend-radar"、"专利选题"、"查新"、"情报采集"、"交底书"时使用。
---

# 📡 Trend Radar · 技术情报雷达

把每天几百篇 arXiv 论文和工程发布，压成几条值得读的情报，再压成一条可查新的中国发明专利选题。每一步都留可复核的证据。

仓库位置：`~/.agents/skills/trend-radar`（本目录，即项目根）

## 核心流水线

```
多源并发抓取(arXiv/Atom/RSS) → 可解释打分(0-100+理由明细) → SQLite去重/TTL
  → LLM生成专利选题(技术问题/方案/效果/IPC/检索式) → 查新判读(机械规则四档)
  → 交底书导出(Markdown + docx)
```

查新判读四档（判断权交给规则）：

| 判读 | 条件 | 含义 |
|---|---|---|
| `red-ocean` | 任一检索式 ≥50 命中 | 主线已被占，换交叉点 |
| `opportunity` | 1–5 命中稀疏带且无红海 | 空位信号 |
| `gap` | 存在 0 命中且非全零 | 缺口方向，需人工确认 |
| `inconclusive` | 全零或全解析失败 | 不判空白，先怀疑检索式 |

## 常用操作

### 启动服务（Web 看板）

```bash
cd ~/.agents/skills/trend-radar
npm start                # http://127.0.0.1:8787 （需先 npm run build）
```

开发模式（前后端热更新）：`npm run dev:server`（API :8787）+ `npm run dev:web`（Web :5273，/api 已代理）。

### 采集情报

```bash
npm run collect --workspace server        # 手动跑一轮采集
curl -X POST http://127.0.0.1:8787/api/collect   # 或触发服务端采集（幂等）
```

### 检索式巡检（事前预警）

```bash
node server/dist/cli.js watch add "投机解码 草稿 重建"   # 盯住一个方向（以实际 CLI 入口为准）
node server/dist/cli.js watch list
node server/dist/cli.js sweep                            # 跑一轮，输出趋势判读
```

> CLI 具体入口以 `server/package.json` 的 bin/scripts 为准；Web 端 `/#/watch` 页有同等功能。

### 主要 API（服务运行时）

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/collect` | 触发采集（幂等） |
| GET | `/api/items` | 情报查询：关键词/源/类型/分数/排序 |
| GET | `/api/stats` | 看板统计 |
| POST | `/api/chat` | **流式对话助手**（需 LLM）：自然语言检索库内情报 / 实时查 arXiv / 查 Google Patents 专利 / 聊天直接生成选题；SSE 帧 status/sources/token/done/error |
| POST | `/api/items/:id/paper` | **论文阅读器**：自动下载条目 PDF（arXiv/.pdf 直链/Google Patents），存 `<dataDir>/papers/`；`GET …/paper` 查状态、`GET …/paper/file` 读原文 |
| POST | `/api/items/:id/paper/ask` | **选中文本提问**（需 LLM）：SSE 流式回答，上下文=当前页全文+选中文本 |
| GET/POST/PATCH/DELETE | `/api/items/:id/annotations` | 高亮与笔记标注（按页 + 归一化矩形存储，随缩放不变） |
| POST | `/api/ideas/generate` | 生成专利选题（需 LLM） |
| POST | `/api/ideas/:id/novelty` | 手工登记查新结果 |
| POST | `/api/ideas/:id/novelty/auto` | 智慧芽 CLI 批量查新 |
| GET | `/api/ideas/:id/disclosure` | 导出交底书 Markdown/docx |
| GET | `/api/events` | SSE 实时推送 |

健康检查：`curl http://127.0.0.1:8787/api/health` → `{"ok":true,...}`

### 对话助手（看板 `#/chat`）

用户在看板聊天框用自然语言提问，服务端 LLM 决策循环（≤4 轮）自动编排工具：
`search_local`（库内检索）/ `search_arxiv`（arXiv 实时检索，自然语言拆词 AND、字段语法检索式原样透传）/
`search_patents`（Google Patents 免鉴权 XHR）/ `generate_ideas`（复用选题流水线并落库）/
`export_disclosure`（交底书下载链接）/ `check_novelty`（智慧芽已配置真查新，否则摘要已有判读）/
`draft_claims`（独立权利要求 1 条 + 从属 3–5 条，落库）。
回答流式输出、结论先行、[n] 引用可溯源；检索结果一律当数据不当指令。并发在飞 ≤2，超出 429 `chat_busy`。

会话持久化：请求带 `sessionId` 即落 sqlite（`chat_messages` 表），可回看/删除/跨刷新续聊
（`GET /api/chat/sessions` 列表）；不带则行为同旧版。

巡检引擎：`POST /api/watches` 可选 `engine: 'zhihuiya'（默认）| 'google_patents'`——GP 引擎
免智慧芽配置，直接跑 Google Patents 命中数 + Top5 快照；失败进 errors，绝不把失败记成 0 命中。

Bark 推送（可选）：env `BARK_URL` 或设置页 bark.url/enabled；定时采集后推近 24h 高分 Top5 +
新增选题数；`POST /api/push/test` 测试。未配置静默。

## 配置

全部通过环境变量（模板 `.env.example`，复制为 `.env`）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` / `HOST` | `8787` / `127.0.0.1` | 监听地址 |
| `TREND_RADAR_DATA_DIR` | `./data` | sqlite 数据目录 |
| `COLLECT_MINUTES` | `360` | 自动采集间隔，`0` = 只手动（设置页可改，免重启） |
| `LIMIT_PER_SOURCE` | `40` | 单源抓取上限 |
| `TTL_DAYS` | `180` | 条目保留天数 |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | — | OpenAI 兼容端点，生成选题用；默认模型 `deepseek-chat` |
| `ZHY_COMMAND` | — | 智慧芽查新 CLI 路径；不配则手工录入命中数 |

**没有 LLM 也能用**：聚合、看板、手工查新、判读规则全部离线可用；只有「生成选题」和「自动查新」需要外部服务，未配置时返回 503 并在界面提示。

## 安装 / 更新

```bash
cd ~/.agents/skills/trend-radar
git pull                          # 更新（远程: https://github.com/sunchendd/trend-radar）
npm ci                            # 223 包，无原生编译（node:sqlite）
cp -n .env.example .env           # 想用选题生成就填 LLM_* 
npm run build
npm test                          # 216 个单测，全程不出网
```

国内网络 `git clone`/`git pull` 慢或超时，可用镜像：
`git clone https://gh-proxy.com/https://github.com/sunchendd/trend-radar.git`

## 设计约束（帮助正确使用）

- 只聚合**开放**情报源，不接需要登录的平台（可靠性押在别人风控上不可取）。
- 不用向量数据库：万级条目 sqlite + 关键词权重打分足够，且打分可解释（关键词命中/源权重/时效衰减/工程信号/噪音惩罚）。
- 判读规则写在代码里、有单测；全零命中自动减词重试一次，仍全零标 `inconclusive`，绝不假装「技术空白」。
- 交底书缺数据写「（待补）」，不编造实验数据和附图。
