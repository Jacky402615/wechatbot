import { appendFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { LogLevel } from './config';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export class BotLogger {
  private lastDay = '';

  constructor(private opts: { level: LogLevel; logDir: string; console?: boolean; now?: () => Date }) {
    this.lastDay = this.today();
    this.prune();
  }

  debug(event: string, fields?: Record<string, unknown>): void { this.write('debug', event, fields); }
  info(event: string, fields?: Record<string, unknown>): void { this.write('info', event, fields); }
  warn(event: string, fields?: Record<string, unknown>): void { this.write('warn', event, fields); }
  error(event: string, fields?: Record<string, unknown>): void { this.write('error', event, fields); }

  asSdkLogger() {
    const wrap = (level: LogLevel) => (message: string, ...args: unknown[]) => {
      this.write(level, message, args.length > 0 ? { args } : undefined);
    };
    return { debug: wrap('debug'), info: wrap('info'), warn: wrap('warn'), error: wrap('error') };
  }

  close(): void {
    if (!existsSync(this.currentPath())) this.write('info', 'logger-closed-empty');
  }

  private now(): Date { return this.opts.now ? this.opts.now() : new Date(); }

  private today(): string {
    return this.now().toISOString().slice(0, 10).replace(/-/g, '');
  }

  private currentPath(): string {
    return join(this.opts.logDir, `gateway-${this.today()}.jsonl`);
  }

  private write(level: LogLevel, event: string, fields?: Record<string, unknown>): void {
    if (LEVELS[level] < LEVELS[this.opts.level]) return;
    const day = this.today();
    if (day !== this.lastDay) {   // 跨日：滚动 + 清理
      this.lastDay = day;
      this.prune();
    }
    const entry = { ts: this.now().toISOString(), level, event, ...fields };
    try {
      appendFileSync(join(this.opts.logDir, `gateway-${day}.jsonl`), JSON.stringify(entry) + '\n');
    } catch (e) {
      // feishubot #62: 日志失败必须可见，绝不吞掉
      process.stderr.write(`logger write failed: ${(e as Error).message}\n`);
    }
    if (this.opts.console) {
      const line = `[${level}] ${event}${fields ? ' ' + JSON.stringify(fields) : ''}`;
      (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
    }
  }

  private prune(): void {
    const cutoff = this.now().getTime() - 14 * 86400_000;
    try {
      for (const name of readdirSync(this.opts.logDir)) {
        const m = /^gateway-(\d{8})\.jsonl$/.exec(name);
        if (!m) continue;
        const day = m[1]!;
        const ts = Date.parse(`${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`);
        if (Number.isFinite(ts) && ts < cutoff) rmSync(join(this.opts.logDir, name));
      }
    } catch {
      /* 目录尚不存在：构造方已保证存在 */
    }
  }
}
