import { test, expect } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotLogger } from '../../src/logger';

test('写 JSONL 且级别过滤生效', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-log-'));
  const log = new BotLogger({ level: 'info', logDir: dir, console: false });
  log.debug('noisy', { x: 1 });
  log.info('started', { pid: 42 });
  log.error('boom', { err: 'bad' });
  log.close();
  const files = readdirSync(dir);
  expect(files.length).toBe(1);
  const lines = readFileSync(join(dir, files[0]!), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  expect(lines.length).toBe(2);
  expect(lines[0]!).toEqual(expect.objectContaining({ level: 'info', event: 'started', pid: 42 }));
  expect(lines[0]!.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(lines[1]!.level).toBe('error');
});

test('清理 14 天前的旧日志', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-log-'));
  const oldName = `gateway-${new Date(Date.now() - 16 * 86400_000).toISOString().slice(0, 10).replace(/-/g, '')}.jsonl`;
  writeFileSync(join(dir, oldName), '{}\n');
  const log = new BotLogger({ level: 'info', logDir: dir, console: false });
  log.info('hi');
  log.close();
  expect(readdirSync(dir).includes(oldName)).toBe(false);
});

test('asSdkLogger 适配 SDK Logger 接口', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-log-'));
  const log = new BotLogger({ level: 'debug', logDir: dir, console: false });
  const sdk = log.asSdkLogger();
  sdk.warn('ws close', 'code', 1006);
  log.close();
  const f = readdirSync(dir)[0]!;
  const line = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  expect(line).toEqual(expect.objectContaining({ level: 'warn', event: 'ws close', args: ['code', 1006] }));
});

test('跨日滚动：时钟跨天后新写入落到新日期文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-log-'));
  let fakeNow = new Date('2026-09-13T23:59:30Z');
  const log = new BotLogger({ level: 'info', logDir: dir, console: false, now: () => fakeNow });
  log.info('before-midnight');
  fakeNow = new Date('2026-09-14T00:00:30Z');
  log.info('after-midnight');
  log.close();
  const files = readdirSync(dir).sort();
  expect(files.length).toBe(2);
  expect(files[0]).toBe('gateway-20260913.jsonl');
  expect(files[1]).toBe('gateway-20260914.jsonl');
});
