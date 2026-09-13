import { test, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Gateway } from '../../src/gateway';
import { AgentHandler } from '../../src/handlers/agent';
import { AgentManager } from '../../src/agent/manager';
import { SessionStore } from '../../src/agent/session-store';
import { BotLogger } from '../../src/logger';
import { AccessGate } from '../../src/access';
import { MediaStore } from '../../src/media';
import type { TransportEvent, TransportHandler, WeComTransport } from '../../src/transport/types';

class FakeTransport implements WeComTransport {
  private handlers: TransportHandler[] = [];
  replyStreamImpl: () => Promise<void> = async () => undefined;
  async start(): Promise<void> { this.emit({ type: 'authenticated' }); }
  async stop(): Promise<void> { this.emit({ type: 'disconnected', reason: 'stopped' }); }
  async replyStream(): Promise<void> { await this.replyStreamImpl(); }
  async replyWelcome(): Promise<void> {}
  async downloadFile(): Promise<{ buffer: Buffer; filename?: string }> { return { buffer: Buffer.alloc(0) } }
  connectionStatus(): { connected: boolean; authenticated: boolean } { return { connected: true, authenticated: true }; }
  isConnected(): boolean { return true; }
  on(handler: TransportHandler): void { this.handlers.push(handler); }
  emit(event: TransportEvent): void { for (const h of this.handlers) h(event); }
}

test('fatal 事件：Gateway 持久化 lastError/running=false 并触发 onFatal 回调', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-fatal-'));
  mkdirSync(join(dir, 'logs'), { recursive: true });
  const transport = new FakeTransport();
  const logger = new BotLogger({ level: 'info', logDir: join(dir, 'logs'), console: false });
  const gateway = new Gateway({ transport, logger, botDir: dir, handler: { register() {} } });
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

test('agent 回复失败传播进 Gateway 状态（lastError 持久化，不吞）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-fatal-'));
  mkdirSync(join(dir, 'logs'), { recursive: true });
  mkdirSync(join(dir, 'state'), { recursive: true });
  process.env.FAKE_CLAUDE_STATE_DIR = join(dir, 'state');
  process.env.FAKE_CLAUDE_SCENARIO = 'happy';
  const transport = new FakeTransport();
  transport.replyStreamImpl = async () => { throw new Error('reply rejected: errcode=40001'); };
  const logger = new BotLogger({ level: 'info', logDir: join(dir, 'logs'), console: false });
  const sessions = new SessionStore(join(dir, 'sessions'));
  const manager = new AgentManager({
    workspacePath: dir, sessions, logger,
    options: { claudeCommand: { command: process.execPath, argsPrefix: [join(import.meta.dir, '..', 'helpers', 'fake-claude.mjs')] } },
  });
  let gatewayRef: Gateway | null = null;
  writeFileSync(join(dir, 'access.json'), JSON.stringify({ admin: ['u1'] }) + '\n'); // W3 基线
  const access = new AccessGate(join(dir, 'access.json'));
  const handler = new AgentHandler({ transport, logger, manager, workspace: dir, access, media: new MediaStore(join(dir, 'uploads')) }, {
    onReplyError: (e) => gatewayRef?.recordAgentError(e), // 与 createGateway 生产接线同构（R2-F5）
  });
  const gateway = new Gateway({ transport, logger, botDir: dir, handler });
  gatewayRef = gateway;
  await gateway.start();
  transport.emit({ type: 'textMessage', message: { msgid: 'm1', chatType: 'single', userId: 'u1', content: 'x', replyTo: { __brand: 'ReplyRef', reqId: 'r1' } } });
  await new Promise((r) => setTimeout(r, 600));
  const st = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as { lastError?: string };
  expect(st.lastError).toMatch(/reply rejected/);
  await gateway.stop();
});
