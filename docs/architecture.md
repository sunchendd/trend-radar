# 架构与设计取舍

## 目标

做一块**给技术情报/专利选题用**的看板，而不是又一个 RSS 阅读器。判断标准只有一条：
> 用户看完一屏，能不能决定「今天该读哪三条、该往哪个交叉点去布专利」。

## 模块边界

| 模块 | 职责 | 不做什么 |
|---|---|---|
| `server/src/sources/*` | 把外部各种格式（arXiv Atom / RSS / GitHub Releases）规整成 `Item` | 不碰数据库、不打分 |
| `server/src/score.ts` | 纯函数打分：关键词、源权重、时效、工程信号、噪音惩罚 | 不做 IO（这样才能单测） |
| `server/src/store/*` | sqlite 读写、去重、TTL、分页 | 不写业务规则 |
| `server/src/collect.ts` | 调度：并发抓、隔离失败、去重后落库、记录 `RunRecord` | 不决定"哪条重要" |
| `server/src/ideas/*` | 选题生成、结构校验、查新对接、判读规则 | 不直接开 HTTP |
| `server/src/http/*` | 路由、zod 校验、错误映射、SSE、静态托管 | 不写业务算法 |
| `web/*` | 看板 UI | 不重复实现判读规则（只展示后端结论） |

依赖方向单向：`http → ideas/store/collect → sources/score → types`。`types.ts` 是冻结契约，前端复制一份保持同步。

## 几个关键决策

### 1. 用 `node:sqlite` 而不是 better-sqlite3
数据量万级、单进程写入，不需要独立数据库。`node:sqlite`（Node 22.5+ 内置）避免了原生模块编译，`npm ci` 在 Windows/macOS/Linux 和 slim 镜像里都能过。
代价：API 是实验性的，Node 大版本升级要回归一次（CI 已锁 node 24）。

### 2. 打分可解释，而不是黑箱相关性
每条情报带 `scoreReasons`（规则名 + 增减分 + 说明）。理由：
- 用户要的是「为什么值得读」，不是排序分数本身；
- 调权重时能看到影响哪一批条目；
- 出问题时可以只改一条规则并单测，不用重跑模型。

### 3. 判读交给机械规则，且明确保留「无法判断」档
`red-ocean / opportunity / gap / inconclusive` 四档，其中 `inconclusive` 专门接住「全部 0 命中」。
**全零不等于空白**：中文专利库的简单检索是 AND 语义，5 个词的组合天然为 0。把它当空白会直接导致立项方向错误，这个坑真实踩过。
因此规则里强制：全零先自动减词重试（≥3 词），仍全零则判 `inconclusive` 并提示人工复核。

### 4. 外部能力缺失时显式报错，不静默降级
没有 LLM → `/api/ideas/generate` 返回 `503 llm_not_configured`，界面提示怎么配；
没有查新 CLI → 同理，同时保留「手工录入命中数」的通道。
静默降级（例如生成假选题、把 0 命中当成功）会让用户拿着假数据去开评审会。

### 5. 只聚合开放情报源
不接需要登录/签名的平台接口。这类集成在个人试验里能跑，在产品里是**不可维护的负债**：接口改一次、风控升一次，看板就空一次。源是可插拔的，想加什么自己写适配器。

## 数据流

1. `collect`：`sources` 并发抓 → 解析成 `Item` → `score` 打分 → `store` 按 `id`/`externalId` 去重插入 → 写 `RunRecord` → SSE 广播。
2. `ideas.generate`：取高分条目（≤12）→ prompt → LLM → `extractJson` → 结构校验 → 标题 Jaccard 去重 → 落库 → 广播。
3. `novelty`：检索式 → 外部 CLI → 命中数/头部申请人 → `verdict()` → 更新 `Idea.status` → 广播。

## 失败模式与处理

| 失败 | 处理 |
|---|---|
| 单个源 500/超时 | 记入 `RunRecord.errors`，其余源照常入库 |
| arXiv API 返回 500（并发同 URL） | 同 URL 只请求一次，结果复用；只用 https |
| LLM 输出被 maxTokens 截断 | `extractJson` 抛 `truncated` 标志，提示减少数量（实测 count=5 会截断，故默认 3） |
| 模型返回围栏/前后缀 | 去围栏 + 配对括号扫描后再 parse |
| 查新 CLI 不存在 | 503 + 手工录入通道 |
| 全零命中 | 减词重试一次 → 仍全零判 `inconclusive` |
| web/dist 不存在（纯 API 模式） | 跳过静态托管，不崩 |
