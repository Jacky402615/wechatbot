import { test, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Gateway } from '../../src/gateway';
import { BotLogger } from '../../src/logger';
import type { TransportEvent, TransportHandler, WeComTransport } from '../../src/transport/types';

class FakeTransport implements WeComTransport {
  private handlers: TransportHandler[] = [];
  async start(): Promise<void> { this.emit({ type: 'authenticated' }); }
  async stop(): Promise<void> { this.emit({ type: 'disconnected', reason: 'stopped' }); }
  async replyStream(): Promise<void> { /* W1 fatal 测试不需要 */ }
  isConnected(): boolean { return true; }
  on(handler: TransportHandler): void { this.handlers.push(handler); }
  emit(event: TransportEvent): void { for (const h of this.handlers) h(event); }
}

test('fatal 事件：Gateway 持久化 lastError/running=false 并触发 onFatal 回调', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-fatal-'));
  mkdirSync(join(dir, 'logs'), { recursive: true });
  const transport = new FakeTransport();
  const logger = new BotLogger({ level: 'info', logDir: join(dir, 'logs'), console: false });
  const gateway = new Gateway({ transport, logger, botDir: dir });
  const fatalErrors: Error[] = [];
  gateway.onFatal((e) => fatalErrors.push(e));
  await gateway.start();
  transport.emit({ type: 'fatal', error: new Error('auth exhausted while self-healing') });
  expect(fatalErrors.length).toBe(1);
  expect(fatalErrors[0]!.message).toMatch(/auth exhausted/);
  const st = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as { running: boolean; lastError?: string };
  expect(st.running).toBe(false);
  expect(st.lastError).toMatch(/auth exhausted/);
  const logText = readFileSync(join(dir, 'logs', `gateway-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.jsonl`), 'utf8');
  expect(logText).toMatch(/fatal transport error/);
});
