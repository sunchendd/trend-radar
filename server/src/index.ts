#!/usr/bin/env node
import { loadConfig } from './config.js';

const [command = 'serve'] = process.argv.slice(2);
const config = loadConfig();

const usage = `trend-radar — 技术情报聚合看板 + 专利选题生产线

用法:
  trend-radar collect [--source <id>]   抓取一次情报
  trend-radar watch add "<检索式>"      新增巡检方向（盯住它，命中数异动就是选题触发器）
  trend-radar watch list                列出巡检方向与最近命中数
  trend-radar sweep                     跑一轮巡检并输出趋势判读
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
  case 'watch': {
    const { openDb } = await import('./store/db.js');
    const { addWatch, listWatches, removeWatch, setWatchEnabled } = await import('./store/watches.js');
    const db = openDb(config.dataDir);
    const [sub, ...rest] = process.argv.slice(3);
    if (sub === 'add') {
      const query = rest.join(' ').trim();
      if (query === '') {
        console.error('用法：trend-radar watch add "投机解码 草稿 重建"');
        process.exit(2);
      }
      const watch = addWatch(db, { query });
      console.log(JSON.stringify(watch, null, 2));
    } else if (sub === 'rm') {
      console.log(removeWatch(db, rest[0] ?? '') ? '已删除' : '没找到该巡检项');
    } else if (sub === 'off' || sub === 'on') {
      const watch = setWatchEnabled(db, rest[0] ?? '', sub === 'on');
      console.log(watch ? JSON.stringify(watch, null, 2) : '没找到该巡检项');
    } else {
      for (const watch of listWatches(db, true)) {
        const state = watch.enabled ? 'ON ' : 'off';
        console.log(`${state} ${watch.id}  最近命中=${watch.lastHits ?? '—'}  巡检${watch.checks}次  ${watch.query}`);
      }
    }
    db.close();
    break;
  }
  case 'sweep': {
    const { openDb } = await import('./store/db.js');
    const { sweepWatches } = await import('./sweep.js');
    const db = openDb(config.dataDir);
    const result = await sweepWatches(config, db);
    console.log(JSON.stringify(result, null, 2));
    db.close();
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
