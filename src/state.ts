import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface GatewayState {
  pid: number;
  running: boolean;
  connected: boolean;
  authenticated: boolean;
  updatedAt: string;
  lastError?: string;
  kickedCount: number;
  reconnects: number;
  lastEventAt?: string;
}

export class StateError extends Error {}

export function writeState(botDir: string, state: GatewayState): void {
  const final = join(botDir, 'state.json');
  const tmp = join(botDir, `.state.json.tmp-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
    renameSync(tmp, final);
  } catch (e) {
    process.stderr.write(`state write failed: ${(e as Error).message}\n`);
    throw new StateError(`state write failed: ${(e as Error).message}`);
  }
}

export function readState(botDir: string): GatewayState | null {
  const final = join(botDir, 'state.json');
  if (!existsSync(final)) return null;
  try {
    return JSON.parse(readFileSync(final, 'utf8')) as GatewayState;
  } catch (e) {
    throw new StateError(`state file corrupt at ${final}: ${(e as Error).message}`);
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
