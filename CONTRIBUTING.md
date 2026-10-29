# 参与开发

## 环境

- Node **≥ 22.5**（用到内置 `node:sqlite`；CI 锁 24）
- 无需数据库、无需 Docker 也能全功能跑起来

```bash
npm install
npm run dev:server   # :8787
npm run dev:web      # :5273（/api 已代理）
```

## 提交前自检

```bash
npm run typecheck    # server + web 都要干净
npm test             # server 单测
npm run build        # 两个包都要能构建
```

CI 会额外跑一次「起服务 + `/api/health` 探活」的 smoke test，本地不用重复。

## 代码约定

- **TypeScript strict**，不允许 `any`（需要逃生舱时用 `unknown` + 类型守卫，并在 review 里说明）。
- 注释写**为什么**，不写**是什么**。
- `server/src/types.ts` 是冻结契约：改它必须同时更新 `docs/api.md` 和 `web/src/lib/types.ts`，并在 PR 描述里写清影响面。
- 判读与打分是**纯函数**，新增规则必须带单测（见 `server/test/verdict.test.ts`、`score.test.ts`）。
- 外部调用（LLM / 查新 CLI / HTTP）一律可注入或可 mock，测试**不许打真网络**。

## 加一个情报源

1. 在 `server/src/sources/` 里确认已有适配器能覆盖（`arxiv` / `atom` / `rss` 三种够用绝大多数）；
2. 在 `defaults.ts` 加一条，`note` 必须写**为什么加这个源**；
3. 跑 `npm run collect --workspace server`，确认 `RunRecord.errors` 为空。

## 提交信息

`<type>(<scope>): <一句话>`，type ∈ feat|fix|docs|test|refactor|chore|perf。
