#!/usr/bin/env node
import { loadConfig } from './config.js';

const [command = 'serve'] = process.argv.slice(2);
const config = loadConfig();

const usage = `trend-radar — 技术情报聚合看板 + 专利选题生产线

用法:
  trend-radar collect [--source <id>]   抓取一次情报
  trend-radar serve                     启动 API + Web
  trend-radar ideas <focus>              终端里生成选题
  trend-radar stats                     打印当前统计

数据目录: ${config.dataDir}
`;

switch (command) {
  case 'collect': {
    // 用 runCollectDetailed 而不是 runCollect：CLI 想看到「每个源花了多久」，
    // 但这不属于 RunRecord 契约（冻结），所以只在命令行输出里旁挂 perSource
    const { runCollectDetailed } = await import('./collect.js');
    const { run, perSource } = await runCollectDetailed(config);
    console.log(JSON.stringify({ ...run, perSource }, null, 2));
    break;
  }
  case 'serve': {
    const { startServer } = await import('./http/app.js');
    await startServer(config);
    break;
  }
  case 'stats': {
    const { openDb } = await import('./store/db.js');
    const { stats } = await import('./store/queries.js');
    console.log(JSON.stringify(stats(openDb(config.dataDir)), null, 2));
    break;
  }
  default:
    console.log(usage);
}
