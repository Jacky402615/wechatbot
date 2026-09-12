import { join } from 'node:path';
import { loadWorkspace } from '../config';
import { readPidFile, isOurProcess } from '../pid';
import { readState, StateError } from '../state';

export async function status(opts: { workspace: string }): Promise<number> {
  const ws = loadWorkspace(opts.workspace);
  const entry = readPidFile(join(ws.botDir, 'gateway.pid'));
  let st = null;
  try {
    st = readState(ws.botDir);
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
