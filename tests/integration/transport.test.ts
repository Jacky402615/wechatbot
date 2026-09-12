import { test, expect } from 'bun:test';
import { WecomSdkTransport, type TransportEvent, type TransportHandler, type InboundEnterChat } from '../../src/transport/wecom-sdk-adapter';
import { MockWecomServer } from '../helpers/mock-wecom-server';

const FAST = { reconnectInterval: 50, heartbeatInterval: 200, requestTimeout: 2000, resubscribeDelayMs: 150 };

async function waitUntil(cond: () => boolean, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitUntil timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}

function recorder(): { events: TransportEvent[]; push: TransportHandler } {
  const events: TransportEvent[] = [];
  return { events, push: (e) => events.push(e) };
}

test('AC1 路径：认证失败 start() reject 且错误可见', async () => {
  const srv = new MockWecomServer({ authErrcode: 40001 });
  const { url } = await srv.start();
  const t = new WecomSdkTransport({ botId: 'b', secret: 'bad', wsUrl: url, maxAuthFailureAttempts: 2, ...FAST });
  await expect(t.start()).rejects.toThrow(/auth|WS_AUTH|subscribe/i);
  await srv.stop();
});

test('认证成功：start resolve，事件序列含 connected/authenticated', async () => {
  const srv = new MockWecomServer();
  const { url } = await srv.start();
  const t = new WecomSdkTransport({ botId: 'b', secret: 's', wsUrl: url, ...FAST });
  const rec = recorder();
  t.on(rec.push);
  await t.start();
  expect(t.isConnected()).toBe(true);
  expect(rec.events.map((e) => e.type)).toContain('authenticated');
  await t.stop();
  await srv.stop();
});

test('AC2 路径：socket 被杀后自动重连（重新 subscribe）', async () => {
  const srv = new MockWecomServer();
  const { url } = await srv.start();
  const t = new WecomSdkTransport({ botId: 'b', secret: 's', wsUrl: url, maxReconnectAttempts: -1, ...FAST });
  const rec = recorder();
  t.on(rec.push);
  await t.start();
  expect(srv.subscribeCount).toBe(1);
  srv.kill();
  await waitUntil(() => srv.subscribeCount >= 2);
  expect(rec.events.some((e) => e.type === 'reconnecting')).toBe(true);
  await waitUntil(() => t.isConnected());
  await t.stop();
  await srv.stop();
});

test('AC3 路径：disconnected_event（被踢）后无需重启恢复，且恢复后继续服务（再 echo 一条）', async () => {
  const srv = new MockWecomServer();
  const { url } = await srv.start();
  const t = new WecomSdkTransport({ botId: 'b', secret: 's', wsUrl: url, maxReconnectAttempts: -1, ...FAST });
  const rec = recorder();
  t.on(rec.push);
  await t.start();
  srv.kick();
  await waitUntil(() => rec.events.some((e) => e.type === 'kicked'));
  await waitUntil(() => srv.subscribeCount >= 2 && t.isConnected());
  // 恢复后继续服务：新消息仍能收到并正确回执（AC3 的 "recovers" 不只是连上）
  const sentBefore = srv.sentFrames.length;
  srv.pushTextMessage('req-after-kick', { msgid: 'mk', userId: 'u1', content: 'still alive' });
  await waitUntil(() => rec.events.some((e) => e.type === 'textMessage' && e.message.replyTo.reqId === 'req-after-kick'));
  const msg = rec.events.find((e) => e.type === 'textMessage' && e.message.replyTo.reqId === 'req-after-kick')!;
  if (msg.type !== 'textMessage') throw new Error('unreachable');
  await t.replyStream(msg.message.replyTo, 'sk', 'still alive', true);
  await waitUntil(() => srv.sentFrames.length === sentBefore + 1);
  const f = srv.sentFrames[srv.sentFrames.length - 1]!;
  expect(f.headers.req_id).toBe('req-after-kick');
  await t.stop();
  await srv.stop();
});

test('textMessage 事件携带解析后的 DTO 与 reqId', async () => {
  const srv = new MockWecomServer();
  const { url } = await srv.start();
  const t = new WecomSdkTransport({ botId: 'b', secret: 's', wsUrl: url, ...FAST });
  const rec = recorder();
  t.on(rec.push);
  await t.start();
  srv.pushTextMessage('req-1', { msgid: 'm1', userId: 'u1', content: 'hello' });
  await waitUntil(() => rec.events.some((e) => e.type === 'textMessage'));
  const msg = rec.events.find((e) => e.type === 'textMessage')!;
  expect(msg).toEqual({
    type: 'textMessage',
    message: { msgid: 'm1', chatType: 'single', chatId: undefined, userId: 'u1', content: 'hello', replyTo: { __brand: 'ReplyRef', reqId: 'req-1' } },
  });
  await t.stop();
  await srv.stop();
});

test('群聊帧：chatid 解析进 chatId；缺 chatid 的群帧被忽略', async () => {
  const srv = new MockWecomServer();
  const { url } = await srv.start();
  const t = new WecomSdkTransport({ botId: 'b', secret: 's', wsUrl: url, ...FAST });
  const rec = recorder();
  t.on(rec.push);
  await t.start();
  srv.pushTextMessage('req-g1', { msgid: 'g1', userId: 'u1', content: 'hi group', chatType: 'group', chatid: 'wrGroupId' });
  await waitUntil(() => rec.events.some((e) => e.type === 'textMessage'));
  const msg = rec.events.find((e) => e.type === 'textMessage')!;
  if (msg.type !== 'textMessage') throw new Error('unreachable');
  expect(msg.message.chatType).toBe('group');
  expect(msg.message.chatId).toBe('wrGroupId');
  // 缺 chatid 的群帧：忽略（无新 textMessage 事件）
  srv.pushTextMessage('req-g2', { msgid: 'g2', userId: 'u1', content: 'bad', chatType: 'group' });
  await new Promise((r) => setTimeout(r, 300));
  expect(rec.events.filter((e) => e.type === 'textMessage').length).toBe(1);
  await t.stop();
  await srv.stop();
});

test('replyStream 发送 aibot_respond_msg 帧且 finish 透传', async () => {
  const srv = new MockWecomServer();
  const { url } = await srv.start();
  const t = new WecomSdkTransport({ botId: 'b', secret: 's', wsUrl: url, ...FAST });
  await t.start();
  const ref = { __brand: 'ReplyRef', reqId: 'req-9' } as const;
  await t.replyStream(ref, 'stream-1', 'echo back', true);
  await waitUntil(() => srv.sentFrames.length === 1);
  const f = srv.sentFrames[0]!;
  expect(f.cmd).toBe('aibot_respond_msg');
  expect(f.headers.req_id).toBe('req-9');
  expect(f.body).toEqual({ msgtype: 'stream', stream: { id: 'stream-1', content: 'echo back', finish: true } });
  await t.stop();
  await srv.stop();
});

test('错误事件被记录且不吞（feishubot #62）：SDK error 事件转发', async () => {
  const srv = new MockWecomServer();
  const { url } = await srv.start();
  const t = new WecomSdkTransport({ botId: 'b', secret: 's', wsUrl: url, ...FAST });
  const rec = recorder();
  t.on(rec.push);
  await t.start();
  t.emitTestError(new Error('injected'));
  expect(rec.events.some((e) => e.type === 'error' && /injected/.test(e.error.message))).toBe(true);
  await t.stop();
  await srv.stop();
});

test('被踢后凭据失效：认证耗尽不无限重订阅（fatal 识别穿透 cause）', async () => {
  const srv = new MockWecomServer();
  const { url } = await srv.start();
  const t = new WecomSdkTransport({ botId: 'b', secret: 's', wsUrl: url, maxAuthFailureAttempts: 2, ...FAST });
  const rec = recorder();
  t.on(rec.push);
  await t.start();
  srv.setAuthErrcode(40001);   // 被踢后服务端开始拒绝我们的凭据
  srv.kick();
  await waitUntil(() => rec.events.some((e) => e.type === 'kicked'));
  // 等待重订阅尝试走完认证重试（2 次 × FAST 退避）后停下
  await new Promise((r) => setTimeout(r, 2_500));
  const subscribesAfterSettle = srv.subscribeCount;
  await new Promise((r) => setTimeout(r, 1_500));
  expect(srv.subscribeCount).toBe(subscribesAfterSettle);   // 没有无限重订阅循环
  expect(rec.events.some((e) => e.type === 'error')).toBe(true);
  // 真实 adapter 必须上报 fatal（宿主据此退出进程，而不是空转）
  expect(rec.events.some((e) => e.type === 'fatal')).toBe(true);
  await t.stop();
  await srv.stop();
}, 15_000);

test('W3：enterChat/feedbackEvent 事件到达 handler；replyWelcome 走 aibot_respond_welcome_msg；connectionStatus 双字段；平台拒绝 reject', async () => {
  const srv = new MockWecomServer();
  const { url } = await srv.start();
  const t = new WecomSdkTransport({ botId: 'b', secret: 's', wsUrl: url, ...FAST });
  const rec = recorder();
  t.on(rec.push);
  await t.start();
  expect(t.connectionStatus()).toEqual({ connected: true, authenticated: true });
  const t0 = Date.now();
  srv.pushEnterChat('req-ec1', { msgid: 'ec1', userId: 'u9' });
  srv.pushFeedbackEvent('req-fb1', { msgid: 'fb1', userId: 'u9' });
  await new Promise((r) => setTimeout(r, 300));
  const ec = rec.events.find((e) => e.type === 'enterChat') as { type: 'enterChat'; message: InboundEnterChat } | undefined;
  expect(ec).toBeDefined();
  expect(ec!.message.userId).toBe('u9');
  expect(ec!.message.chatType).toBe('single');
  expect(ec!.message.replyTo.reqId).toBe('req-ec1');
  expect(rec.events.some((e) => e.type === 'feedbackEvent')).toBe(true);
  await t.replyWelcome(ec!.message.replyTo, '欢迎');
  expect(srv.welcomeFrames.length).toBe(1);
  expect((srv.welcomeFrames[0]!.body as { text?: { content?: string } }).text?.content).toBe('欢迎');
  expect(Date.now() - t0).toBeLessThan(5_000);
  // R3-F3：平台拒绝（errcode≠0）⇒ replyWelcome reject（handler 的 ERROR 审计依赖此契约）
  srv.welcomeErrcode = 40097;
  await expect(t.replyWelcome(ec!.message.replyTo, '再发一次')).rejects.toThrow(/errcode=40097/);
  srv.welcomeErrcode = 0;
  await t.stop();
  expect(t.connectionStatus()).toEqual({ connected: false, authenticated: false });
  await srv.stop();
});
