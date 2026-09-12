import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readPidFile, isOurProcess, isPidAlive } from '../pid';
import { readState, writeState, StateError } from '../state';

export async function stop(opts: { workspace: string }): Promise<number> {
  // 管理面不依赖 config/.env 校验：config 损坏也必须能停掉还在跑的网关
  const botDir = join(opts.workspace, '.bot');
  const pidPath = join(botDir, 'gateway.pid');
  const pidfileExisted = existsSync(pidPath);
  const entry = readPidFile(pidPath);
  if (entry === null) {
    if (pidfileExisted) {
      // pidfile 存在但无法解析：归属不明，不做破坏性清理，交人工处置
      process.stderr.write(`[wechatbot] pidfile 存在但无法解析，拒绝清理：${pidPath}（人工确认后删除）\n`);
      return 1;
    }
    process.stdout.write('网关未在运行\n');
    return 0;
  }
  const pid = entry.pid;
  if (!isOurProcess(entry)) {
    process.stdout.write('网关未在运行\n');
    rmSync(pidPath, { force: true });
    return 0;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ESRCH') {
      process.stderr.write(`[wechatbot] SIGTERM 失败 (pid ${pid}): ${(e as Error).message}\n`);
      return 1;
    }
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && isPidAlive(pid)) await new Promise((r) => setTimeout(r, 200));
  if (isPidAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH') {
        process.stderr.write(`[wechatbot] SIGKILL 失败 (pid ${pid}): ${(e as Error).message}\n`);
        return 1;
      }
    }
    process.stdout.write(`pid ${pid} 未在 5s 内退出，已 SIGKILL\n`);
  }
  rmSync(pidPath, { force: true });
  try {
    const st = readState(botDir);
    if (st) writeState(botDir, { ...st, running: false, connected: false, updatedAt: new Date().toISOString() });
  } catch (e) {
    if (e instanceof StateError) {
      // 进程停止是主职责，state 更新失败不阻断——但必须留痕，不吞（feishubot #62）
      process.stderr.write(`[wechatbot] stop: state 更新失败（进程已停止）: ${e.message}\n`);
    } else {
      throw e;
    }
  }
  process.stdout.write(`网关已停止 (pid ${pid})\n`);
  return 0;
}
