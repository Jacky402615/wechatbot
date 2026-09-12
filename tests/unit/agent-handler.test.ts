import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentHandler, ConversationRateLimiter } from '../../src/handlers/agent';
import type { AgentEvent, AgentEventHandler } from '../../src/agent/manager';
import type { InboundTextMessage, ReplyRef, TransportEvent, TransportHandler, WeComTransport } from '../../src/transport/types';
import { BotLogger } from '../../src/logger';

class FakeTransport implements WeComTransport {
  sent: Array<{ streamId: string; content: string; finish: boolean }> = [];
  replyImpl: (content: string, finish: boolean) => Promise<void> = async () => undefined;
  private handlers: TransportHandler[] = [];
  async start() {} async stop() {} isConnected() { return true; }
  on(h: TransportHandler) { this.handlers.push(h); }
  emit(e: TransportEvent) { for (const h of this.handlers) h(e); }
  async replyStream(_ref: ReplyRef, streamId: string, content: string, finish: boolean) {
    this.sent.push({ streamId, content, finish });
    await this.replyImpl(content, finish);
  }
}

class FakeManager {
  submitted: Array<{ chatKey: string; prompt: string }> = [];
  answers: string[] = [];
  answerResult: 'answered' | 'invalid_numeric' | 'none' = 'answered';
  submitResult: 'started' | 'queued' | 'queue-full' | 'shutdown' = 'started';
  pendingFlag = false;
  nextEvents: Array<(emit: (ev: AgentEvent) => void) => void> = [];
  submit(chatKey: string, _ct: 'single' | 'group', _u: string, prompt: string, onEvent: AgentEventHandler) {
    this.submitted.push({ chatKey, prompt });
    const gen = this.nextEvents.shift();
    if (gen) queueMicrotask(() => gen(onEvent));
    return this.submitResult;
  }
  answerPendingAsk(_k: string, text: string, _uid?: string) { this.answers.push(text); return this.answerResult; }
  hasPendingAsk() { return this.pendingFlag; }
  expireStaleAsk() { return false; }
  async closeAll() {}
}

function makeHandler(manager = new FakeManager(), opts: { onReplyError?: (e: Error) => void } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-hdl-'));
  mkdirSync(join(dir, 'logs'), { recursive: true });
  const transport = new FakeTransport();
  const logger = new BotLogger({ level: 'debug', logDir: join(dir, 'logs'), console: false });
  const handler = new AgentHandler({ transport, logger, manager, workspace: dir }, { refreshIntervalMs: 10, ...opts });
  return { handler, transport, manager, dir, logger };
}

const MSG = (over: Partial<InboundTextMessage> = {}): { type: 'textMessage'; message: InboundTextMessage } => ({
  type: 'textMessage',
  message: { msgid: 'm1', chatType: 'single', userId: 'u1', content: 'hi', replyTo: { __brand: 'ReplyRef', reqId: 'r1' }, ...over },
});
const flush = (ms = 50) => new Promise((r) => setTimeout(r, ms));

test('AC1 桥：text_delta 节流刷新（同 stream.id）→ turn_complete 终帧 finish=true', async () => {
  const { handler, transport, manager } = makeHandler();
  handler.register();
  manager.nextEvents.push((emit) => {
    emit({ type: 'text_delta', chatKey: 'single:u1', text: '第一段' });
    emit({ type: 'text_delta', chatKey: 'single:u1', text: '第二段' });
    emit({ type: 'turn_complete', chatKey: 'single:u1', finalText: '第一段第二段' });
  });
  transport.emit(MSG());
  await flush();
  const ids = new Set(transport.sent.map((f) => f.streamId));
  expect(ids.size).toBe(1);
  expect(transport.sent.at(-1)!.finish).toBe(true);
  expect(transport.sent.at(-1)!.content).toBe('第一段第二段');
  expect(transport.sent[0]!.content).toContain('第一段');
});

test('前导注入：入站 prompt 携带 [Context: sender=…] 前缀（含 p2p 标注）', async () => {
  const { handler, transport, manager } = makeHandler();
  handler.register();
  transport.emit(MSG());
  await flush();
  expect(manager.submitted[0]!.prompt.startsWith('[Context: sender=u1, userid=u1, chat=u1 (p2p)]\n\n')).toBe(true);
});

test('群聊缺 chatId 的帧被 handler 忽略', async () => {
  const { handler, transport, manager } = makeHandler();
  handler.register();
  transport.emit(MSG({ chatType: 'group' })); // 无 chatId
  await flush();
  expect(manager.submitted.length).toBe(0);
});

test('AC4 桥：ask 渲染收流 finish=true；无效数字走通知流；作答转发 manager', async () => {
  const { handler, transport, manager } = makeHandler();
  handler.register();
  manager.nextEvents.push((emit) => {
    emit({ type: 'text_delta', chatKey: 'single:u1', text: '确认：' });
    emit({ type: 'ask', chatKey: 'single:u1', questions: [{ question: '选哪个？', options: [{ label: '甲' }, { label: '乙' }] }] });
  });
  transport.emit(MSG());
  await flush();
  const askFrame = transport.sent.at(-1)!;
  expect(askFrame.finish).toBe(true);
  expect(askFrame.content).toContain('1. 甲');
  expect(askFrame.content).toContain('2. 乙');
  // 无效数字 → 通知流（一次性，不影响 ask 续流）
  manager.pendingFlag = true;
  manager.answerResult = 'invalid_numeric';
  transport.emit(MSG({ content: '99' }));
  await flush();
  expect(transport.sent.at(-1)!.finish).toBe(true);
  expect(transport.sent.at(-1)!.content).toMatch(/无效选项/);
  // 合法数字 → 转发作答
  manager.answerResult = 'answered';
  transport.emit(MSG({ content: '1' }));
  await flush();
  expect(manager.answers.at(-1)).toBe('1');
  // 作答后的续输出开新流（绑作答回调）
  const before = transport.sent.length;
  manager.nextEvents.push((emit) => {
    emit({ type: 'text_delta', chatKey: 'single:u1', text: '续' });
    emit({ type: 'turn_complete', chatKey: 'single:u1', finalText: '续' });
  });
  // 直接调 submit 的 onEvent（FakeManager 闭包）——经 MSG 再次入站会走 answerPendingAsk='none' 路径
  manager.pendingFlag = false;
  transport.emit(MSG({ content: '继续' }));
  await flush();
  const lastFrame = transport.sent.at(-1)!;
  expect(lastFrame.finish).toBe(true);
  expect(lastFrame.content).toContain('续');
  void before;
});

test('turn_failed：终帧带通用错误文案 + onReplyError 上抛', async () => {
  const errs: Error[] = [];
  const { handler, transport, manager } = makeHandler(new FakeManager(), { onReplyError: (e) => errs.push(e) });
  handler.register();
  manager.nextEvents.push((emit) => {
    emit({ type: 'turn_failed', chatKey: 'single:u1', error: 'turn timeout exceeded' });
  });
  transport.emit(MSG());
  await flush();
  expect(transport.sent.at(-1)!.content).toContain('⏱ 回合超时');
  expect(transport.sent.at(-1)!.finish).toBe(true);
  expect(errs.length).toBe(1);
});

test('队列满通知：queue-full 回执一次性通知流', async () => {
  const { handler, transport, manager } = makeHandler();
  handler.register();
  manager.submitResult = 'queue-full';
  transport.emit(MSG());
  await flush();
  expect(transport.sent.length).toBe(1);
  expect(transport.sent[0]!.finish).toBe(true);
  expect(transport.sent[0]!.content).toMatch(/队列已满/);
});

test('replyStream 失败：onReplyError 上抛且终帧后闭流（不重试）', async () => {
  const errs: Error[] = [];
  const { handler, transport, manager } = makeHandler(new FakeManager(), { onReplyError: (e) => errs.push(e) });
  transport.replyImpl = async () => { throw new Error('reply rejected: errcode=40001'); };
  handler.register();
  manager.nextEvents.push((emit) => {
    emit({ type: 'turn_complete', chatKey: 'single:u1', finalText: 'X' });
  });
  transport.emit(MSG());
  await flush();
  expect(errs.length).toBeGreaterThanOrEqual(1);
  expect(/reply rejected/.test(errs[0]!.message)).toBe(true);
});

test('ConversationRateLimiter：双窗（假时钟）；会话间隔离；record() 逃逸记账后窗口更紧', () => {
  let now = 0;
  const lim = new ConversationRateLimiter({ perMinute: 3, perHour: 5, now: () => now });
  expect(lim.tryAcquire('k')).toBe(true);
  expect(lim.tryAcquire('k')).toBe(true);
  expect(lim.tryAcquire('k')).toBe(true);
  expect(lim.tryAcquire('k')).toBe(false);        // 分钟窗满
  now = 61_000;                                   // 分钟窗滑出、小时窗仍在
  expect(lim.tryAcquire('k')).toBe(true);         // 第 4 帧（小时窗 4/5）
  expect(lim.tryAcquire('k')).toBe(true);         // 第 5 帧（小时窗 5/5）
  expect(lim.tryAcquire('k')).toBe(false);        // 小时窗满（分钟窗已滑出——证双窗独立）
  expect(lim.tryAcquire('other')).toBe(true);     // 会话间隔离
  lim.record('k');                                // 逃逸记账：第 6 帧强行入账
  now = 2 * 61_000;                               // 分钟窗再滑出
  expect(lim.tryAcquire('k')).toBe(false);        // 小时窗 6/5 仍满——record 不是免费通行证
});

test('终帧有界等待→逃逸记账：预算耗尽时 final 仍发出、且记账压制后续（注入假限流器）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-hdl-'));
  mkdirSync(join(dir, 'logs'), { recursive: true });
  const transport = new FakeTransport();
  const logger = new BotLogger({ level: 'debug', logDir: join(dir, 'logs'), console: false });
  const recorded: string[] = [];
  const exhausted = { tryAcquire: (_k: string) => false, record: (k: string) => recorded.push(k) }; // 永远没预算
  const mgr = new FakeManager();
  const handler = new AgentHandler(
    { transport, logger, manager: mgr, workspace: dir },
    { rateLimiter: exhausted as unknown as ConversationRateLimiter, finalWaitIntervalMs: 5, finalWaitMaxTries: 3 },
  );
  handler.register();
  mgr.nextEvents.push((emit) => { emit({ type: 'turn_complete', chatKey: 'single:u1', finalText: 'X' }); });
  transport.emit(MSG());
  await flush(100);
  expect(transport.sent.length).toBe(1);          // 终帧在 3 次 × 5ms 等待后强制发出
  expect(transport.sent[0]!.finish).toBe(true);
  expect(recorded).toEqual(['single:u1']);        // 逃逸已记账
});

test('通知帧预算耗尽即丢（不等待不逃逸）：queue-full 通知被 exhausted 限流器吞掉', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-hdl-'));
  mkdirSync(join(dir, 'logs'), { recursive: true });
  const transport = new FakeTransport();
  const logger = new BotLogger({ level: 'debug', logDir: join(dir, 'logs'), console: false });
  const exhausted = { tryAcquire: (_k: string) => false, record: (_k: string) => {} };
  const mgr = new FakeManager();
  mgr.submitResult = 'queue-full';
  const handler = new AgentHandler(
    { transport, logger, manager: mgr, workspace: dir },
    { rateLimiter: exhausted as unknown as ConversationRateLimiter },
  );
  handler.register();
  transport.emit(MSG());
  await flush(50);
  expect(transport.sent.length).toBe(0); // 通知被丢（非关键）
});

test('ask 字节保底（code-review C6）：超长已产出文本不截掉编号清单——选项行完整在场', async () => {
  const { handler, transport, manager } = makeHandler();
  handler.register();
  const longText = '很长的前置输出。'.repeat(3_000); // 远超 20000 字节预算
  manager.nextEvents.push((emit) => {
    emit({ type: 'text_delta', chatKey: 'single:u1', text: longText });
    emit({
      type: 'ask', chatKey: 'single:u1',
      questions: [
        { question: '第一题？', options: [{ label: '甲' }, { label: '乙' }] },
        { question: '第二题？', options: [{ label: '丙' }, { label: '丁' }], multiSelect: true },
      ],
    });
  });
  transport.emit(MSG());
  await flush(80);
  const askFrame = transport.sent.at(-1)!;
  expect(askFrame.finish).toBe(true);
  expect(Buffer.byteLength(askFrame.content, 'utf8')).toBeLessThanOrEqual(20_000);
  expect(askFrame.content).toContain('❓ 第一题？');
  expect(askFrame.content).toContain('1. 甲');
  expect(askFrame.content).toContain('2. 乙');
  expect(askFrame.content).toContain('3. 丙');
  expect(askFrame.content).toContain('4. 丁');        // 编号清单完整——未被前置输出挤出预算
  expect(askFrame.content.indexOf('…[截断]')).toBeLessThan(askFrame.content.indexOf('❓ 第一题？')); // 截断标记只落在前置文本
});
