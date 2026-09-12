import { join } from 'node:path';
import { readPidFile, isOurProcess } from '../pid';
import { readState, StateError } from '../state';
import { ensureWorkspaceTree } from '../config';

export async function status(opts: { workspace: string }): Promise<number> {
  // 管理面不依赖 config/.env 校验：config 损坏也必须能报告连接状态。
  // 首启建树保留（README 快速开始用 status 初始化工作区），失败不阻塞状态报告。
  const botDir = join(opts.workspace, '.bot');
  try {
    ensureWorkspaceTree(botDir);
  } catch (e) {
    process.stderr.write(`[wechatbot] 工作区初始化失败（不影响状态报告）: ${(e as Error).message}\n`);
  }
  const entry = readPidFile(join(botDir, 'gateway.pid'));
  let st = null;
  try {
    st = readState(botDir);
  } catch (e) {
    if (e instanceof StateError) {
      process.stdout.write(`wechatbot: state corrupt (${e.message})\n`);
      return 1;
    }
    throw e;
  }
  const alive = entry !== null && isOurProcess(entry);
  if (!alive && (st === null || !st.running)) {
    process.stdout.write('wechatbot: not running\n');
    return 0;
  }
  const normalized = alive ? st : { ...st, running: false, connected: false, stale: true };
  process.stdout.write(JSON.stringify({ pid: entry?.pid ?? st?.pid ?? null, ...normalized, pidAlive: alive }, null, 2) + '\n');
  return 0;
}
