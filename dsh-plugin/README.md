# dsh-plugin · 情报雷达侧边栏插件

把 trend-radar 看板装进 DeepSeek Harness 侧边栏：同源反代（`/trend-radar/*`）、
按需拉起服务进程（`127.0.0.1:8787`）、`/api/trend-radar` 动作路由、8 个 `trend_*`
模型工具。结构与 `dsh-shortvideo/dsh-plugin` 同模式。

```
dsh-plugin/
├── index.js          # 宿主半区：按需 spawn server + 反代（SSE 流式直通）+ 动作路由 + 工具
├── client.js         # client 半区：侧边栏「情报雷达」入口 + 同源 iframe 铺满
├── cordis.patch.yml  # bundle patch：insert id=trend-radar 的默认 config
├── package.json      # @local/dsh-trend-radar，dsh.bundle.patch + dsh.client 声明
├── locale/zh.json    # 面板名与描述
├── locale/en.json
├── icon.svg          # 雷达图标
└── README.md         # 本文件
```

## macOS 安装（三步）

```bash
# ① 构建产物（插件只跑构建产物，不依赖 Vite 5273 开发端口）
cd <仓库根>            # 例如 /Users/sunchendong/Desktop/dsh-plugins/trend-radar
npm install --no-audit --no-fund
npm run build          # 产出 server/dist/index.js 与 web/dist/

# ② 装进 desktop profile（CLI 不能管理 desktop profile，用脚本编辑 profile + pnpm install；
#    见 dsh-plugins/scripts/activate-desktop.sh，幂等，先备份）
#    dependencies 追加：
#      "@local/dsh-trend-radar": "link:<仓库根>/dsh-plugin"
#    dsh.profile.bundles 追加： "@local/dsh-trend-radar"

# ③ 用户自己重启 DeepSeek Harness（⌘Q 退出 → Dock 重新打开），侧边栏出现「情报雷达」。
#    会话/脚本绝不代替用户 kill 或重启 GUI 进程。
```

## 配置（cordis.patch.yml 的 config）

| 键 | 默认 | 说明 |
|---|---|---|
| `port` | `8787` | 服务端口，只绑 `127.0.0.1`；外部访问一律走 `/trend-radar` 反代 |
| `repo` | 自动探测 | 仓库根（插件目录上一级）；仅仓库挪动后才需显式指定 |
| `dataDir` | `~/.trend-radar` | sqlite 数据目录；与旧工具桥同目录，旧数据无缝继承 |

## 反代行为（合同要点）

- `text/event-stream`（`/api/events`）：**流式直通**，不缓冲、不改写——采集完成后看板
  自动更新靠它，缓冲会静默失效。
- 其余文本（html/js/json/svg）：缓冲并把 `/api/`、`/assets/`、`/favicon` 改写为
  `/trend-radar/…` 前缀形式。
- 二进制（交底书 docx 导出等）：pipe 直通，`content-length` 原样保留。

## 工具

`trend_radar`（status/start/stop/restart）+ 自旧工具桥原样移植的
`trend_status` / `trend_collect` / `trend_items` / `trend_ideas` /
`trend_idea_generate` / `trend_idea_detail` / `trend_watch`（同名同参同渲染文本）。
旧 web profile 工具桥退役步骤见 `reports/02-architecture.md` §5。

## 排查

| 症状 | 处置 |
|---|---|
| 面板 503 JSON | `tail ~/.dsh/trend-radar/server.log`；`npm run build` 是否跑过 |
| 端口占用 | `lsof -nP -iTCP:8787 -sTCP:LISTEN`；杀占用进程，或改 `config.port` 后重启 Harness |
| 资产 404 / 白屏 | `curl -s http://127.0.0.1:<GUI端口>/trend-radar/ \| head`：资产引用应为 `/trend-radar/assets/…`；仍是 `/assets/…` 说明反代改写未生效 |
| SSE 不自动更新 | `curl -fsS -N -m 3 http://127.0.0.1:8787/api/events \| head -2` 应见 `event: hello`；再对 `/trend-radar/api/events` 复测反代直通 |
| 工具报「服务未构建」 | 在仓库根 `npm install && npm run build`，重试 |
