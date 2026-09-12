#!/usr/bin/env node
import { run as runCmd } from './commands/run';
import { start as startCmd } from './commands/start';
import { stop as stopCmd } from './commands/stop';
import { status as statusCmd } from './commands/status';

const USAGE = `wechatbot — WeCom 智能机器人 gateway（长连接模式）

用法: wechatbot <command> [-r <workspace>]
命令: run | start | stop | status
  run     前台运行网关
  start   后台守护启动
  stop    停止后台网关
  status  报告连接状态
选项: -r <workspace>  工作区目录（默认 $PWD，状态与日志在 <workspace>/.bot/）
      -h, --help     显示本帮助`;

export async function runCli(argv: string[]): Promise<number> {
  let command = '';
  let workspace = process.cwd();
  let workspaceSeen = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '-h' || a === '--help') { process.stdout.write(USAGE + '\n'); return 0; }
    if (a === '-r') {
      const v = argv[i + 1];
      if (!v || v.startsWith('-')) { process.stderr.write('错误: -r 需要一个目录参数\n'); return 2; }
      if (workspaceSeen) { process.stderr.write('错误: -r 只能出现一次\n'); return 2; }
      workspace = v; workspaceSeen = true; i += 1;
    } else if (!command) {
      command = a;
    } else {
      process.stderr.write(`错误: 未知参数 ${a}\n${USAGE}\n`); return 2;
    }
  }
  if (!['run', 'start', 'stop', 'status'].includes(command)) {
    process.stderr.write(command ? `错误: 未知命令 ${command}\n${USAGE}\n` : USAGE + '\n');
    return 2;
  }
  switch (command) {
    case 'run': return runCmd({ workspace });
    case 'start': return startCmd({ workspace });
    case 'stop': return stopCmd({ workspace });
    case 'status': return statusCmd({ workspace });
  }
  return 2; // 上方 includes 校验后不可达
}

// 可移植入口判断（node/bun 双运行时；import.meta.main 是 Bun 专属）。
// 双侧 realpath：npm bin 软链时 argv[1] 可能保留链接路径而模块已被运行时 realpath。
import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

function isEntry(): boolean {
  if (!process.argv[1]) return false;
  try {
    const fromArgv = realpathSync(process.argv[1]);
    let fromModule = fileURLToPath(import.meta.url);
    try { fromModule = realpathSync(fromModule); } catch { /* 模块路径不可 realpath 时保原值 */ }
    return fromArgv === fromModule;
  } catch {
    return false;
  }
}

if (isEntry()) {
  process.exit(await runCli(process.argv.slice(2)));
}
