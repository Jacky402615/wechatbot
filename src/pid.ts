import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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

export function writePidFile(path: string, pid: number): PidFile {
  const entry: PidFile = { pid, startedAt: processStartTime(pid) };
  const tmp = `${path}.tmp-${pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(entry));
  renameSync(tmp, path);   // 原子：崩溃不会留下半写的 pidfile
  return entry;
}

export type PidFileRead = { kind: 'missing' } | { kind: 'invalid' } | { kind: 'ok'; entry: PidFile };

/** 启动路径用：区分"无记录"与"记录损坏/不可验证"——后者拒绝启动（可能是活网关的记录） */
export function readPidFileDetailed(path: string): PidFileRead {
  if (!existsSync(path)) return { kind: 'missing' };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<PidFile>;
    if (typeof raw.pid !== 'number' || raw.pid <= 0) return { kind: 'invalid' };
    // startedAt 缺失 = 归属不可验证：按 invalid 处理——本仓写入前必检，只会来自外来/遗留写入
    if (typeof raw.startedAt !== 'number') return { kind: 'invalid' };
    return { kind: 'ok', entry: { pid: raw.pid, startedAt: raw.startedAt } };
  } catch {
    return { kind: 'invalid' };
  }
}

export function readPidFile(path: string): PidFile | null {
  const rd = readPidFileDetailed(path);
  if (rd.kind === 'invalid') {
    process.stderr.write(`[wechatbot] pidfile 无法解析，视为无记录: ${path}\n`);
    return null;
  }
  return rd.kind === 'ok' ? rd.entry : null;
}

/** pid 存活且启动时间匹配——防 pid 复用误杀/误报。
 *  记录缺失 startedAt（写 pidfile 时 /proc 不可读）时拒绝认定：宁可让 status 报陈旧、
 *  让 stop 报"未在运行"，不可对未验证的 pid 发信号。 */
export function isOurProcess(entry: PidFile): boolean {
  if (!isPidAlive(entry.pid)) return false;
  if (entry.startedAt === null) return false;
  return processStartTime(entry.pid) === entry.startedAt;
}

export { isPidAlive };
