import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, openSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadWorkspace } from '../config';
import { readPidFile, writePidFile, isOurProcess, isPidAlive } from '../pid';
import { readState } from '../state';

const START_CONFIRM_TIMEOUT_MS = 45_000;   // 认证退避下坏凭据 ~30-35s 才响亮退出，留余量
const POLL_INTERVAL_MS = 500;

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
  const pid = child.pid!;
  // exit 事件而非 kill(pid,0) 轮询：detached 子进程退出（含被 reap 前的僵尸窗口）都能观测
  let childExited = false;
  child.once('exit', () => { childExited = true; });
  try {
    writePidFile(pidPath, pid);   // 立即持久化：失败则杀掉子进程，不留孤儿网关
  } catch (e) {
    await killChild(child);
    process.stderr.write(`[wechatbot] pidfile 写入失败，已终止子进程: ${(e as Error).message}\n`);
    return 1;
  }
  // 轮询到"确认已连接 / 子进程退出 / 超时"——start 返回 0 必须意味着订阅已确认
  const connected = await confirmStartup(() => childExited, ws.botDir, pid);
  if (!connected) {
    await killChild(child);
    rmSync(pidPath, { force: true });
    process.stderr.write(`网关未能确认连接（子进程退出或 ${START_CONFIRM_TIMEOUT_MS / 1000}s 超时）；详见 ${ws.botDir}/logs/daemon-stderr.log\n`);
    return 1;
  }
  process.stdout.write(`网关已后台启动并确认连接 (pid ${pid})；状态: wechatbot status -r ${opts.workspace}\n`);
  return 0;
}

async function confirmStartup(childExited: () => boolean, botDir: string, pid: number): Promise<boolean> {
  const deadline = Date.now() + START_CONFIRM_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (childExited()) return false;                // 子进程已响亮退出（AC1 路径）
    try {
      const st = readState(botDir);
      if (st?.connected === true && st.pid === pid) return true;
    } catch { /* state 损坏按未连接处理，继续轮询 */ }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return false;
}

async function killChild(child: ChildProcess): Promise<void> {
  if (child.pid) {
    try {
      process.kill(child.pid, 'SIGKILL');
    } catch { /* ESRCH：已退出 */ }
  }
  // 有界等待退出：不因清理路径挂死 start
  await Promise.race([
    new Promise<void>((r) => child.once('exit', () => r())),
    new Promise<void>((r) => setTimeout(r, 3000)),
  ]);
}
