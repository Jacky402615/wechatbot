import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadWorkspace } from '../config';
import { readPidFile, isOurProcess, isPidAlive } from '../pid';
import { readState, writeState } from '../state';

export async function stop(opts: { workspace: string }): Promise<number> {
  const ws = loadWorkspace(opts.workspace);
  const pidPath = join(ws.botDir, 'gateway.pid');
  const entry = readPidFile(pidPath);
  const pid = entry?.pid ?? null;
  if (entry === null || !isOurProcess(entry)) {
    process.stdout.write('网关未在运行\n');
    rmSync(pidPath, { force: true });
    return 0;
  }
  process.kill(pid!, 'SIGTERM');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && isPidAlive(pid!)) await new Promise((r) => setTimeout(r, 200));
  if (isPidAlive(pid!)) {
    process.kill(pid!, 'SIGKILL');
    process.stdout.write(`pid ${pid} 未在 5s 内退出，已 SIGKILL\n`);
  }
  rmSync(pidPath, { force: true });
  try {
    const st = readState(ws.botDir);
    if (st) writeState(ws.botDir, { ...st, running: false, connected: false, updatedAt: new Date().toISOString() });
  } catch (e) {
    // 进程停止是主职责，state 更新失败不阻断——但必须留痕，不吞（feishubot #62）
    process.stderr.write(`[wechatbot] stop: state 更新失败（进程已停止）: ${(e as Error).message}\n`);
  }
  process.stdout.write(`网关已停止 (pid ${pid})\n`);
  return 0;
}
