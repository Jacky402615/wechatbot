import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isPidAlive } from './state';

export interface PidFile { pid: number; startedAt: number | null }

/** 解析 /proc/<pid>/stat 的第 22 字段 starttime（剥去 "pid (comm) " 后，字段 3 起算 → 字段 22 = 索引 19） */
export function parseStartTime(statLine: string): number | null {
  const close = statLine.lastIndexOf(')');
  if (close < 0) return null;
  const fields = statLine.slice(close + 2).split(' ');
  const v = Number.parseInt(fields[19] ?? '', 10);
  return Number.isFinite(v) ? v : null;
}

/** /proc/<pid>/stat 第 22 字段（启动时钟滴答）；非 Linux 或读取失败返回 null（跳过归属校验） */
export function processStartTime(pid: number): number | null {
  try {
    return parseStartTime(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return null;
  }
}

export function writePidFile(path: string, pid: number): void {
  const entry: PidFile = { pid, startedAt: processStartTime(pid) };
  writeFileSync(path, JSON.stringify(entry));
}

export function readPidFile(path: string): PidFile | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<PidFile>;
    if (typeof raw.pid !== 'number' || raw.pid <= 0) return null;
    return { pid: raw.pid, startedAt: typeof raw.startedAt === 'number' ? raw.startedAt : null };
  } catch {
    return null;
  }
}

/** pid 存活且（可校验时）启动时间匹配——防 pid 复用误杀/误报 */
export function isOurProcess(entry: PidFile): boolean {
  if (!isPidAlive(entry.pid)) return false;
  if (entry.startedAt === null) return true; // 平台不支持校验，降级为仅存活
  return processStartTime(entry.pid) === entry.startedAt;
}

export { isPidAlive };
