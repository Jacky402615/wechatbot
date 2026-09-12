import { test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '../../src/gateway';
import { MockWecomServer } from '../helpers/mock-wecom-server';

const FAST = { reconnectInterval: 50, heartbeatInterval: 500, requestTimeout: 2000, resubscribeDelayMs: 150 };

async function waitUntil(cond: () => boolean, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitUntil timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function setup() {
  const ws = mkdtempSync(join(tmpdir(), 'wb-echo-'));
  const { loadWorkspace } = await import('../../src/config');
  loadWorkspace(ws); // 首启建树
  writeFileSync(join(ws, '.bot', '.env'), 'WECOM_BOT_ID=b\nWECOM_SECRET=s\n'); // 有效测试凭据
  const srv = new MockWecomServer();
  const { url } = await srv.start();
  const { gateway } = await createGateway(ws, { wsUrl: url, ...FAST });
  await gateway.start();
  return { ws, srv, gateway };
}

test('AC4：单聊文本 → 单帧 stream echo，finish=true，req_id 透传', async () => {
  const { srv, gateway } = await setup();
  srv.pushTextMessage('req-42', { msgid: 'm42', userId: 'u1', content: '你好 wecom' });
  await waitUntil(() => srv.sentFrames.length === 1);
  const f = srv.sentFrames[0]!;
  expect(f.cmd).toBe('aibot_respond_msg');
  expect(f.headers.req_id).toBe('req-42');
  const body = f.body as { msgtype: string; stream: { content: string; finish: boolean; id: string } };
  expect(body.msgtype).toBe('stream');
  expect(body.stream.content).toBe('你好 wecom');
  expect(body.stream.finish).toBe(true);
  expect(typeof body.stream.id).toBe('string');
  await gateway.stop();
  await srv.stop();
});

test('AC5 前置：state.json 反映 connected 与事件时间', async () => {
  const { ws, srv, gateway } = await setup();
  const st = JSON.parse(readFileSync(join(ws, '.bot', 'state.json'), 'utf8'));
  expect(st.connected).toBe(true);
  expect(st.authenticated).toBe(true);
  expect(st.running).toBe(true);
  srv.pushTextMessage('req-43', { msgid: 'm43', userId: 'u1', content: 'x' });
  await waitUntil(() => srv.sentFrames.length === 1);
  const st2 = JSON.parse(readFileSync(join(ws, '.bot', 'state.json'), 'utf8'));
  expect(st2.lastEventAt).toBeTruthy();
  await gateway.stop();
  const st3 = JSON.parse(readFileSync(join(ws, '.bot', 'state.json'), 'utf8'));
  expect(st3.running).toBe(false);
  await srv.stop();
});

test('被踢计数进入 state，且恢复后 EchoHandler 仍自动应答（AC3 完整闭环）', async () => {
  const { ws, srv, gateway } = await setup();
  const statePath = join(ws, '.bot', 'state.json');
  srv.kick();
  await waitUntil(() => {
    try {
      return (JSON.parse(readFileSync(statePath, 'utf8')) as { kickedCount: number }).kickedCount >= 1;
    } catch { return false; }
  });
  // 重连完成后：handler 仍注册在 transport 上，新消息自动产生 echo（不经手动 replyStream）
  const sentBefore = srv.sentFrames.length;
  await waitUntil(() => srv.subscribeCount >= 2 && gateway.isConnected());  // 旧 socket 关闭 + 新订阅完成
  srv.pushTextMessage('req-post-kick', { msgid: 'mpk', userId: 'u1', content: 'auto echo after kick' });
  await waitUntil(() => srv.sentFrames.length === sentBefore + 1, 10_000);
  const f = srv.sentFrames[srv.sentFrames.length - 1]!;
  expect(f.headers.req_id).toBe('req-post-kick');
  const body = f.body as { stream: { content: string; finish: boolean } };
  expect(body.stream.content).toBe('auto echo after kick');
  expect(body.stream.finish).toBe(true);
  await gateway.stop();
  await srv.stop();
});

test('空凭据：createGateway 在 transport 构造前抛 EnvError', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'wb-echo-'));
  const { loadWorkspace } = await import('../../src/config');
  loadWorkspace(ws); // .env 为空模板
  await expect(createGateway(ws)).rejects.toThrow(/WECOM_BOT_ID.*empty|WECOM_SECRET.*empty/);
});
