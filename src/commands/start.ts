import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { loadWorkspace } from '../config';
import { readPidFile, writePidFile, isOurProcess, isPidAlive } from '../pid';

export async function start(opts: { workspace: string }): Promise<number> {
  const ws = loadWorkspace(opts.workspace); // 同时完成首启建树；凭据为空在这里不致命（子进程会响亮失败）
  const pidPath = join(ws.botDir, 'gateway.pid');
  const existing = readPidFile(pidPath);
  if (existing !== null && isOurProcess(existing)) {
    process.stderr.write(`已有网关在运行 (pid ${existing.pid})；如需重启先 wechatbot stop\n`);
    return 1;
  }
  mkdirSync(join(ws.botDir, 'logs'), { recursive: true });
  const outFd = openSync(join(ws.botDir, 'logs', 'daemon-stdout.log'), 'a');
  const errFd = openSync(join(ws.botDir, 'logs', 'daemon-stderr.log'), 'a');
  const child = spawn(process.execPath, [process.argv[1]!, 'run', '-r', opts.workspace], {
    detached: true, stdio: ['ignore', outFd, errFd], env: process.env,
  });
  child.unref();
  writePidFile(pidPath, child.pid!);
  // 等待一小段确认子进程没有立刻死掉（凭据缺失等——AC1 经由子进程非零退出兜底）
  await new Promise((r) => setTimeout(r, 1500));
  if (!isPidAlive(child.pid!)) {
    process.stderr.write(`网关子进程启动即退出；详见 ${ws.botDir}/logs/daemon-stderr.log\n`);
    return 1;
  }
  process.stdout.write(`网关已后台启动 (pid ${child.pid})；状态: wechatbot status -r ${opts.workspace}\n`);
  return 0;
}
