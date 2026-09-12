import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, openSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadWorkspace } from '../config';
import { readPidFileDetailed, writePidFile, isOurProcess } from '../pid';
import { readState } from '../state';

const START_CONFIRM_TIMEOUT_MS = 45_000;   // 认证退避下坏凭据 ~30-35s 才响亮退出，留余量
const POLL_INTERVAL_MS = 500;

export async function start(opts: { workspace: string }): Promise<number> {
  const ws = loadWorkspace(opts.workspace); // 同时完成首启建树；凭据为空在这里不致命（子进程会响亮失败）
  const pidPath = join(ws.botDir, 'gateway.pid');
  const rd = readPidFileDetailed(pidPath);
  if (rd.kind === 'invalid') {
    process.stderr.write(`[wechatbot] pidfile 无法解析，拒绝启动（人工确认后删除）: ${pidPath}\n`);
    return 1;
  }
  if (rd.kind === 'ok' && isOurProcess(rd.entry)) {
    process.stderr.write(`已有网关在运行 (pid ${rd.entry.pid})；如需重启先 wechatbot stop\n`);
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
    const entry = writePidFile(pidPath, pid);   // 立即持久化：失败则杀掉子进程，不留孤儿网关
    if (entry.startedAt === null) {
      throw new Error('cannot read /proc starttime — pid ownership unverifiable on this platform');
    }
  } catch (e) {
    await killChild(child, () => childExited);
    process.stderr.write(`[wechatbot] pidfile 写入失败，已终止子进程: ${(e as Error).message}\n`);
    return 1;
  }
  // 轮询到"认证确认 / 子进程退出 / 超时"——start 返回 0 必须意味着订阅已被服务端确认
  const connected = await confirmStartup(() => childExited, ws.botDir, pid);
  if (!connected) {
    const terminated = await killChild(child, () => childExited);
    if (terminated) {
      rmSync(pidPath, { force: true });
    } else {
      // 终止未被证实：保留 pidfile 供 stop/人工处置，不静默脱管
      process.stderr.write(`[wechatbot] 子进程终止未证实，保留 pidfile 供人工处置: ${pidPath}\n`);
    }
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
      if (st?.authenticated === true && st.pid === pid) return true;   // connected 可能早于认证完成
    } catch { /* state 损坏按未连接处理，继续轮询 */ }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return false;
}

/** 终止并证实：信号成功（或已退出）且已观察到 exit（含此前已退出的情况）才返回 true */
async function killChild(child: ChildProcess, childExited: () => boolean): Promise<boolean> {
  let signaled = true;
  if (child.pid) {
    try {
      process.kill(child.pid, 'SIGKILL');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH') {
        process.stderr.write(`[wechatbot] SIGKILL 子进程失败 (pid ${child.pid}): ${(e as Error).message}\n`);
        signaled = false;
      }
    }
  }
  if (childExited()) return signaled;
  const exited = await Promise.race([
    new Promise<boolean>((r) => child.once('exit', () => r(true))),
    new Promise<boolean>((r) => setTimeout(() => r(false), 3000)),
  ]);
  return signaled && exited;
}
