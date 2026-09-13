import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentHandler, ConversationRateLimiter } from '../../src/handlers/agent';
import type { AgentEvent, AgentEventHandler } from '../../src/agent/manager';
import type { InboundTextMessage, InboundMediaMessage, ReplyRef, TransportEvent, TransportHandler, WeComTransport } from '../../src/transport/types';
import { BotLogger } from '../../src/logger';
import { AccessGate } from '../../src/access';
import { MediaStore, MAX_MEDIA_BYTES } from '../../src/media';

class FakeTransport implements WeComTransport {
  sent: Array<{ streamId: string; content: string; finish: boolean }> = [];
  replyImpl: (content: string, finish: boolean) => Promise<void> = async () => undefined;
  welcomes: Array<{ reqId: string; content: string }> = [];
  welcomeImpl: (content: string) => Promise<void> = async () => undefined;
  private handlers: TransportHandler[] = [];
  async start() {} async stop() {} isConnected() { return true; }
  on(h: TransportHandler) { this.handlers.push(h); }
  emit(e: TransportEvent) { for (const h of this.handlers) h(e); }
  async replyStream(_ref: ReplyRef, streamId: string, content: string, finish: boolean) {
    this.sent.push({ streamId, content, finish });
    await this.replyImpl(content, finish);
  }
  downloads: Array<{ url: string; aeskey?: string }> = [];
  downloadImpl: (url: string, aeskey?: string) => Promise<{ buffer: Buffer; filename?: string }> =
    async () => ({ buffer: Buffer.alloc(0) });
  async downloadFile(url: string, aeskey?: string) { this.downloads.push({ url, aeskey }); return this.downloadImpl(url, aeskey); }
  async replyWelcome(ref: ReplyRef, content: string) { this.welcomes.push({ reqId: ref.reqId, content }); await this.welcomeImpl(content); }
  connectionStatus() { return { connected: true, authenticated: true }; }
}

class FakeManager {
  submitted: Array<{ chatKey: string; prompt: string }> = [];
  answers: string[] = [];
  answerResult: 'answered' | 'invalid_numeric' | 'none' | 'answerer-busy' = 'answered';
  submitResult: 'started' | 'queued' | 'queue-full' | 'shutdown' = 'started';
  pendingFlag = false;
  expireResult = false;
  nextEvents: Array<(emit: (ev: AgentEvent) => void) => void> = [];
  aborts: string[] = [];
  resets: string[] = [];
  abortStatus: 'stopped' | 'stopping' | 'idle' = 'idle';
  abortDropped = 0;
  submit(chatKey: string, _ct: 'single' | 'group', _u: string, prompt: string, onEvent: AgentEventHandler) {
    this.submitted.push({ chatKey, prompt });
    const gen = this.nextEvents.shift();
    if (gen) queueMicrotask(() => gen(onEvent));
    return this.submitResult;
  }
  async answerPendingAsk(_k: string, text: string, _uid?: string): Promise<'answered' | 'invalid_numeric' | 'none' | 'answerer-busy'> { this.answers.push(text); return this.answerResult; }
  hasPendingAsk() { return this.pendingFlag; }
  expireStaleAsk() { return this.expireResult; }
  abortChat(chatKey: string) { this.aborts.push(chatKey); return { status: this.abortStatus, dropped: this.abortDropped }; }
  resetSession(chatKey: string) { this.resets.push(chatKey); }
  inFlightCount() { return 0; }
  activeSessionCount() { return { active: 0, corrupt: 0 }; }
  async closeAll() {}
}

function makeHandler(manager = new FakeManager(), opts: { onReplyError?: (e: Error) => void } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-hdl-'));
  mkdirSync(join(dir, 'logs'), { recursive: true });
  writeFileSync(join(dir, 'access.json'), JSON.stringify({ admin: ['u1'] }) + '\n'); // W2 默认 userId=u1 全放行（W3 基线）
  const access = new AccessGate(join(dir, 'access.json'));
  const transport = new FakeTransport();
  const logger = new BotLogger({ level: 'debug', logDir: join(dir, 'logs'), console: false });
  const media = new MediaStore(join(dir, 'uploads'));
  const handler = new AgentHandler({ transport, logger, manager, workspace: dir, access, media }, { refreshIntervalMs: 10, ...opts });
  return { handler, transport, manager, dir, logger, media };
}

function makeGatedHandler(accessJson: unknown, mentionName?: string, manager = new FakeManager()) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-gate-'));
  mkdirSync(join(dir, 'logs'), { recursive: true });
  writeFileSync(join(dir, 'access.json'), JSON.stringify(accessJson) + '\n');
  const access = new AccessGate(join(dir, 'access.json'));
  const transport = new FakeTransport();
  const logger = new BotLogger({ level: 'debug', logDir: join(dir, 'logs'), console: false });
  const media = new MediaStore(join(dir, 'uploads'));
  const handler = new AgentHandler({ transport, logger, manager, workspace: dir, access, media, ...(mentionName !== undefined ? { mentionName } : {}) }, { refreshIntervalMs: 10 });
  return { handler, transport, manager, dir, access, media };
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
  writeFileSync(join(dir, 'access.json'), JSON.stringify({ admin: ['u1'] }) + '\n'); // W3 基线
  const access = new AccessGate(join(dir, 'access.json'));
  const transport = new FakeTransport();
  const logger = new BotLogger({ level: 'debug', logDir: join(dir, 'logs'), console: false });
  const recorded: string[] = [];
  const exhausted = { tryAcquire: (_k: string) => false, record: (k: string) => recorded.push(k) }; // 永远没预算
  const mgr = new FakeManager();
  const handler = new AgentHandler(
    { transport, logger, manager: mgr, workspace: dir, access, media: new MediaStore(join(dir, 'uploads')) },
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
  writeFileSync(join(dir, 'access.json'), JSON.stringify({ admin: ['u1'] }) + '\n'); // W3 基线
  const access = new AccessGate(join(dir, 'access.json'));
  const transport = new FakeTransport();
  const logger = new BotLogger({ level: 'debug', logDir: join(dir, 'logs'), console: false });
  const exhausted = { tryAcquire: (_k: string) => false, record: (_k: string) => {} };
  const mgr = new FakeManager();
  mgr.submitResult = 'queue-full';
  const handler = new AgentHandler(
    { transport, logger, manager: mgr, workspace: dir, access, media: new MediaStore(join(dir, 'uploads')) },
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

test('answerer-busy：作答者达帽的通知流（pr-review P1 桥面）', async () => {
  const { handler, transport, manager } = makeHandler();
  handler.register();
  manager.pendingFlag = true;
  manager.answerResult = 'answerer-busy';
  transport.emit(MSG({ content: '1' }));
  await flush();
  expect(transport.sent.length).toBe(1);
  expect(transport.sent[0]!.finish).toBe(true);
  expect(transport.sent[0]!.content).toMatch(/上限/);
  expect(manager.answers.at(-1)).toBe('1'); // 已转发 manager（由其拒收）
});

test('入站前置失败兜底终帧：expireStaleAsk 抛错 ⇒ 用户收到「处理失败」finish=true（pr-review P3）', async () => {
  const errs: Error[] = [];
  const { handler, transport, manager } = makeHandler(new FakeManager(), { onReplyError: (e) => errs.push(e) });
  manager.expireStaleAsk = () => { throw new Error('EACCES: session read failed'); };
  handler.register();
  transport.emit(MSG());
  await flush();
  expect(transport.sent.length).toBe(1); // 兜底一次性终帧
  expect(transport.sent[0]!.finish).toBe(true);
  expect(transport.sent[0]!.content).toMatch(/处理失败/);
  expect(/EACCES/.test(errs[0]!.message)).toBe(true); // lastError 同步上抛
});

test('ask_expired 只认领处女续流：入站过期路径挂了 banner 的流不被旧代事件误删（R2-C1）', async () => {
  const { handler, transport, manager } = makeHandler();
  handler.register();
  // 第一段：ask 闭流（制造续流）
  manager.nextEvents.push((emit) => {
    emit({ type: 'ask', chatKey: 'single:u1', questions: [{ question: 'Q?', options: [{ label: 'a' }] }] });
  });
  transport.emit(MSG());
  await flush();
  expect(transport.sent.at(-1)!.finish).toBe(true);
  const sentBefore = transport.sent.length;
  // 入站过期路径：expireStaleAsk=true ⇒ onText 给续流挂 banner 并把入站按新回合提交
  manager.expireResult = true;
  manager.nextEvents.push((emit) => {
    emit({ type: 'ask_expired', chatKey: 'single:u1' }); // 旧代的迟到过期事件（banner 在场——非处女流）
    emit({ type: 'text_delta', chatKey: 'single:u1', text: '新回合输出' });
    emit({ type: 'turn_complete', chatKey: 'single:u1', finalText: '新回合输出' });
  });
  transport.emit(MSG({ content: '新消息' }));
  await flush();
  // 旧代 ask_expired 不删流、不发**独立过期通知**（通知文案以句号结尾，与 banner 文案不同）
  expect(transport.sent.filter((f) => f.content === '⚠️ 上一个问题已超时失效。').length).toBe(0);
  const final = transport.sent.at(-1)!;
  expect(final.finish).toBe(true);
  expect(final.content).toContain('上一个问题已超时失效'); // banner 保留
  expect(final.content).toContain('新回合输出');
});

test('关键兜底不受限流丢弃：预算耗尽时入站失败仍发「处理失败」终帧并记账（pr-review R2-P3）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-hdl-'));
  mkdirSync(join(dir, 'logs'), { recursive: true });
  writeFileSync(join(dir, 'access.json'), JSON.stringify({ admin: ['u1'] }) + '\n'); // W3 基线
  const access = new AccessGate(join(dir, 'access.json'));
  const transport = new FakeTransport();
  const logger = new BotLogger({ level: 'debug', logDir: join(dir, 'logs'), console: false });
  const recorded: string[] = [];
  const exhausted = { tryAcquire: (_k: string) => false, record: (k: string) => recorded.push(k) };
  const mgr = new FakeManager();
  mgr.expireStaleAsk = () => { throw new Error('EACCES: session read failed'); };
  const handler = new AgentHandler(
    { transport, logger, manager: mgr, workspace: dir, access, media: new MediaStore(join(dir, 'uploads')) },
    { rateLimiter: exhausted as unknown as ConversationRateLimiter, finalWaitIntervalMs: 5, finalWaitMaxTries: 3 },
  );
  handler.register();
  transport.emit(MSG());
  await flush(100);
  expect(transport.sent.length).toBe(1); // 兜底终帧仍发出（关键路径不丢弃）
  expect(transport.sent[0]!.finish).toBe(true);
  expect(transport.sent[0]!.content).toMatch(/处理失败/);
  expect(recorded).toEqual(['single:u1']); // 逃逸记账在案
});

// ===== W3：gate / 命令 / 群策略 / welcome =====

const logLines = (dir: string): Array<Record<string, unknown>> =>
  readFileSync(join(dir, 'logs', `gateway-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.jsonl`), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);

test('W3 gate：陌生人 p2p 得拒绝文案、不 submit；rejected 同文案；approved 放行', async () => {
  const { handler, transport, manager } = makeGatedHandler({ approved: ['u1'], rejected: ['bad'] });
  handler.register();
  transport.emit(MSG({ userId: 'stranger', content: '/help' })); // 陌生人的命令也只得到拒绝
  await flush();
  expect(transport.sent.at(-1)!.content).toContain('未被授权');
  transport.emit(MSG({ userId: 'bad', content: '你好' }));       // rejected 与 unknown 同文案
  await flush();
  expect(transport.sent.at(-1)!.content).toContain('未被授权');
  expect(manager.submitted.length).toBe(0);
  transport.emit(MSG()); // u1 approved
  await flush();
  expect(manager.submitted.length).toBe(1);
});

test('W3 AC1：四命令分派——均不 submit；未知命令 → 帮助文案', async () => {
  const { handler, transport, manager } = makeGatedHandler({ admin: ['u1'] });
  handler.register();
  for (const c of ['/help', '/status', '/new', '/stop', '/frobnicate']) {
    transport.emit(MSG({ content: c }));
    await flush();
  }
  expect(manager.submitted.length).toBe(0);
  const texts = transport.sent.map((f) => f.content).join('\n--\n');
  expect(texts).toContain('/new');                    // help
  expect(texts).toContain('网关状态');                 // status（admin）
  expect(texts).toContain('已重置会话');               // new
  expect(texts).toContain('当前没有进行中的回合');       // stop（idle）
  expect(texts).toContain('未知命令：/frobnicate');     // unknown → help
  expect(manager.resets.length).toBe(1);              // new 闭档
});

test('W3 /status：approved 用户与群内均拒答（不披露 roster）', async () => {
  const { handler, transport } = makeGatedHandler({ admin: ['boss'], approved: ['u1'], groups: ['g1'] }, '小助手');
  handler.register();
  transport.emit(MSG({ content: '/status' })); // u1 = approved（p2p）
  await flush();
  expect(transport.sent.at(-1)!.content).toContain('仅管理员');
  expect(transport.sent.at(-1)!.content).not.toContain('boss'); // 无 roster 泄露
  transport.emit(MSG({ chatType: 'group', chatId: 'g1', userId: 'boss', content: '@小助手 /status' })); // admin 在群里也拒
  await flush();
  expect(transport.sent.at(-1)!.content).toContain('仅管理员');
  expect(transport.sent.at(-1)!.content).not.toContain('boss');
});

test('W3 /stop：stopped/stopping 不发 idle 提示（回执由中止终帧承载）；idle+dropped 提示清空数', async () => {
  const manager = new FakeManager();
  manager.abortStatus = 'stopped';
  const { handler, transport } = makeGatedHandler({ approved: ['u1'] }, undefined, manager);
  handler.register();
  transport.emit(MSG({ content: '/stop' }));
  await flush();
  expect(manager.aborts.length).toBe(1);
  expect(transport.sent.filter((f) => f.content.includes('当前没有进行中的回合')).length).toBe(0); // 无 idle 误报
  manager.abortStatus = 'stopping'; // 双击
  transport.emit(MSG({ content: '/stop' }));
  await flush();
  expect(transport.sent.filter((f) => f.content.includes('当前没有进行中的回合')).length).toBe(0);
  manager.abortStatus = 'idle'; manager.abortDropped = 2;
  transport.emit(MSG({ content: '/stop' }));
  await flush();
  expect(transport.sent.at(-1)!.content).toContain('已清空 2 条排队消息');
});

test('W3 abort 文案映射：turn_failed(aborted) → 「已停止当前回合」', async () => {
  const { handler, transport, manager } = makeGatedHandler({ approved: ['u1'] });
  handler.register();
  manager.nextEvents.push((emit) => emit({ type: 'turn_failed', chatKey: 'single:u1', error: 'turn aborted by user command' }));
  transport.emit(MSG()); // 起回合——事件经 FakeManager 闭包回放
  await flush();
  expect(transport.sent.at(-1)!.content).toContain('已停止当前回合');
});

test('W3 命令先于 pending-ask：pending ask 期间的 /stop 中止而非作答', async () => {
  const manager = new FakeManager();
  manager.pendingFlag = true;
  const { handler, transport } = makeGatedHandler({ approved: ['u1'] }, undefined, manager);
  handler.register();
  transport.emit(MSG({ content: '/stop' }));
  await flush();
  expect(manager.aborts.length).toBe(1);
  expect(manager.answers.length).toBe(0); // 未消费 ask
});

test('W3 群策略：allowlist+@+剥离进 agent；未 listed 群/rejected/无 @/冒名前缀 忽略', async () => {
  const { handler, transport, manager } = makeGatedHandler({ approved: ['u1'], rejected: ['bad'], groups: ['g1'] }, '小助手');
  handler.register();
  transport.emit(MSG({ chatType: 'group', chatId: 'g1', userId: 'u1', content: '@小助手 群里好' }));
  await flush();
  expect(manager.submitted.at(-1)!.prompt).toContain('群里好');
  expect(manager.submitted.at(-1)!.chatKey).toBe('group:g1');
  const before = manager.submitted.length;
  transport.emit(MSG({ chatType: 'group', chatId: 'g2', userId: 'u1', content: '@小助手 未授权群' })); // 非 listed 群
  transport.emit(MSG({ chatType: 'group', chatId: 'g1', userId: 'bad', content: '@小助手 被拒者' }));   // rejected
  transport.emit(MSG({ chatType: 'group', chatId: 'g1', userId: 'u1', content: '没有@' }));            // 无提及
  transport.emit(MSG({ chatType: 'group', chatId: 'g1', userId: 'u1', content: '@小助手2 冒名' }));     // token 边界
  await flush();
  expect(manager.submitted.length).toBe(before);
});

test('W3 群命令：@bot /stop 在群内分派（群会话可停）', async () => {
  const manager = new FakeManager();
  manager.abortStatus = 'idle'; manager.abortDropped = 2;
  const { handler, transport } = makeGatedHandler({ groups: ['g1'] }, '小助手', manager);
  handler.register();
  transport.emit(MSG({ chatType: 'group', chatId: 'g1', userId: 'anyone', content: '@小助手 /stop' }));
  await flush();
  expect(manager.aborts.length).toBe(1);
  expect(transport.sent.at(-1)!.content).toContain('已清空 2 条排队消息');
});

test('W3 AC4 welcome：allowed→欢迎+命令清单；unknown→拒绝文案；同步调用（零前置 await）；群 enter_chat 忽略', async () => {
  const { handler, transport } = makeGatedHandler({ approved: ['u1'] });
  handler.register();
  transport.emit({ type: 'enterChat', message: { msgid: 'e1', chatType: 'single', userId: 'u1', replyTo: { __brand: 'ReplyRef', reqId: 'r-ec' } } });
  expect(transport.welcomes.length).toBe(1); // 同步 tick 内已发起——5s 窗硬路径（D5）
  expect(transport.welcomes[0]!.content).toContain('/help');
  transport.emit({ type: 'enterChat', message: { msgid: 'e2', chatType: 'single', userId: 'stranger', replyTo: { __brand: 'ReplyRef', reqId: 'r-ec2' } } });
  expect(transport.welcomes[1]!.content).toContain('未被授权');
  transport.emit({ type: 'enterChat', message: { msgid: 'e3', chatType: 'group', chatId: 'g1', userId: 'u1', replyTo: { __brand: 'ReplyRef', reqId: 'r-ec3' } } });
  expect(transport.welcomes.length).toBe(2); // 群 enter_chat 忽略
});

test('W3 feedback_event：仅日志，无任何回执', async () => {
  const { handler, transport } = makeGatedHandler({ approved: ['u1'] });
  handler.register();
  transport.emit({ type: 'feedbackEvent', message: { msgid: 'f1', chatType: 'single', userId: 'u1' } });
  await flush();
  expect(transport.sent.length).toBe(0);
  expect(transport.welcomes.length).toBe(0);
});

test('W3 日志契约（R2-F5）：feedback/拒绝入日志但不记内容；welcome 失败 ERROR 留痕', async () => {
  const { handler, transport, dir } = makeGatedHandler({ approved: ['u1'] });
  handler.register();
  transport.emit({ type: 'feedbackEvent', message: { msgid: 'f1', chatType: 'single', userId: 'u1' } });
  await flush();
  const fb = logLines(dir).find((l) => l['event'] === 'feedback event')!;
  expect(fb['msgid']).toBe('f1');
  expect(JSON.stringify(fb)).not.toContain('消息内容'); // 无内容字段面
  transport.emit(MSG({ userId: 'stranger', content: '秘密内容xyz' }));
  await flush();
  const rej = logLines(dir).find((l) => l['event'] === 'p2p sender not authorized')!;
  expect(JSON.stringify(rej)).not.toContain('秘密内容xyz'); // 拒绝日志不记内容（D8）
  transport.welcomeImpl = async () => { throw new Error('5s window passed'); };
  transport.emit({ type: 'enterChat', message: { msgid: 'e9', chatType: 'single', userId: 'u1', replyTo: { __brand: 'ReplyRef', reqId: 'r-e9' } } });
  await flush();
  expect(logLines(dir).some((l) => l['event'] === 'welcome reply failed' && l['level'] === 'error')).toBe(true);
});

const MEDIA = (over: Partial<InboundMediaMessage> = {}): { type: 'mediaMessage'; message: InboundMediaMessage } => ({
  type: 'mediaMessage',
  message: { msgid: 'mm1', chatType: 'single', userId: 'u1', kind: 'image', url: 'https://f/x.jpg', aeskey: 'k1', replyTo: { __brand: 'ReplyRef', reqId: 'rm1' }, ...over },
});
const todayDir = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

test('W4 AC1/AC2 桥：image/file 下载落盘 → submit prompt 携带 [Context] 前导 + 绝对路径 note', async () => {
  const { handler, transport, manager, dir } = makeHandler();
  handler.register();
  transport.downloadImpl = async () => ({ buffer: Buffer.from('jpegbytes'), filename: 'photo.jpg' });
  transport.emit(MEDIA());
  await flush();
  expect(transport.downloads).toEqual([{ url: 'https://f/x.jpg', aeskey: 'k1' }]);
  expect(manager.submitted.length).toBe(1);
  const prompt = manager.submitted[0]!.prompt;
  expect(prompt.startsWith('[Context: sender=u1, userid=u1, chat=u1 (p2p)]\n\n')).toBe(true);
  expect(prompt).toContain('Read');
  expect(prompt).toContain(join(dir, 'uploads'));       // 绝对路径入 note
  expect(prompt).toContain('mm1-photo.jpg');            // msgid 前缀消毒名
  expect(prompt).toContain('9 字节');                    // 字节数
  expect(existsSync(join(dir, 'uploads', todayDir(), 'mm1-photo.jpg'))).toBe(true);          // 落盘（深断言在 media.test.ts）
});

test('W4 AC3 桥：voice/video 下载归档 → note 含「无法解析」；不携带 Read 指令', async () => {
  const { handler, transport, manager } = makeHandler();
  handler.register();
  transport.downloadImpl = async () => ({ buffer: Buffer.alloc(32) });
  transport.emit(MEDIA({ kind: 'voice', msgid: 'v1' }));
  await flush();
  const p1 = manager.submitted[0]!.prompt;
  expect(p1).toContain('无法解析');
  expect(p1).toContain('amr');
  expect(p1).not.toContain('Read 工具查看');
  transport.emit(MEDIA({ kind: 'video', msgid: 'v2' }));
  await flush();
  expect(manager.submitted[1]!.prompt).toContain('无法解析');
});

test('W4 AC4 桥：下载 throw ⇒ criticalFinal 短错误（不 submit、不下载两次）；错误文案含「重新发送」', async () => {
  const { handler, transport, manager } = makeHandler();
  handler.register();
  transport.downloadImpl = async () => { throw new Error('decryptFile: Decryption failed'); };
  transport.emit(MEDIA());
  await flush();
  expect(manager.submitted.length).toBe(0);
  const last = transport.sent.at(-1)!;
  expect(last.finish).toBe(true);
  expect(last.content).toContain('附件接收失败');
  expect(last.content).toContain('重新发送');
});

test('W4 降级：空 buffer / 超帽 buffer ⇒ 不落盘、submit prompt 携带降级 note、回合照跑', async () => {
  const { handler, transport, manager } = makeHandler();
  handler.register();
  transport.downloadImpl = async () => ({ buffer: Buffer.alloc(0), filename: 'x.jpg' });
  transport.emit(MEDIA({ msgid: 'e1' }));
  await flush();
  expect(manager.submitted[0]!.prompt).toContain('未能成功接收');
  transport.downloadImpl = async () => ({ buffer: Buffer.alloc(MAX_MEDIA_BYTES + 1), filename: 'big.bin' });
  transport.emit(MEDIA({ msgid: 'o1', kind: 'file' }));
  await flush();
  expect(manager.submitted[1]!.prompt).toContain('100MB');
});

test('W4 协议异常：缺 url / 缺 aeskey ⇒ 与下载失败同面（关键终帧错误、零下载、零 submit）', async () => {
  const { handler, transport, manager } = makeHandler();
  handler.register();
  transport.emit(MEDIA({ msgid: 'nu1', url: undefined }));                    // 缺 url（voice .d.ts 形状）
  await flush();
  expect(transport.downloads.length).toBe(0);
  expect(manager.submitted.length).toBe(0);
  expect(transport.sent.at(-1)!.finish).toBe(true);
  expect(transport.sent.at(-1)!.content).toContain('附件接收失败');
  transport.emit(MEDIA({ msgid: 'nk1', aeskey: undefined }));                 // 缺 aeskey——密文不得当附件
  await flush();
  expect(transport.downloads.length).toBe(0);                                 // 未尝试下载（无 key 密文无意义）
  expect(manager.submitted.length).toBe(0);
  expect(transport.sent.at(-1)!.content).toContain('附件接收失败');
});

test('W4 落盘失败 ⇒ 降级 note、回合照跑、仅一次下载（确定性：目标路径预置为目录）', async () => {
  const { handler, transport, manager, dir } = makeHandler();
  handler.register();
  mkdirSync(join(dir, 'uploads', todayDir(), 'sv1-photo.jpg'), { recursive: true });  // writeFileSync 目标是目录 ⇒ EISDIR
  transport.downloadImpl = async () => ({ buffer: Buffer.from('x'), filename: 'photo.jpg' });
  transport.emit(MEDIA({ msgid: 'sv1' }));
  await flush();
  expect(transport.downloads.length).toBe(1);                                // 不重试下载
  expect(manager.submitted.length).toBe(1);
  expect(manager.submitted[0]!.prompt).toContain('未能成功接收');              // save-failed 降级 note
});

test('W4 gate：未授权/陌生人媒体 ⇒ 拒绝文案 + 零下载 + 零 submit；群媒体帧忽略', async () => {
  const { handler, transport, manager } = makeGatedHandler({ approved: ['u1'] });
  handler.register();
  transport.emit(MEDIA({ userId: 'stranger' }));
  await flush();
  expect(transport.sent.at(-1)!.content).toContain('未被授权');
  expect(transport.downloads.length).toBe(0);           // 先拒绝后下载（D4）
  expect(manager.submitted.length).toBe(0);
  transport.emit(MEDIA({ chatType: 'group', chatId: 'g1' }));
  await flush();
  expect(transport.downloads.length).toBe(0);           // 群媒体 handler 防御性忽略
  expect(transport.sent.length).toBe(1);                // 无新增回执
});

test('W4 pending-ask：媒体不认领 ask（无 answerPendingAsk 调用）、照常 submit 排队', async () => {
  const { handler, transport, manager } = makeHandler();
  handler.register();
  manager.pendingFlag = true;
  transport.downloadImpl = async () => ({ buffer: Buffer.from('x'), filename: 'a.png' });
  transport.emit(MEDIA());
  await flush();
  expect(manager.answers.length).toBe(0);               // 未作答
  expect(manager.submitted.length).toBe(1);             // 照常进回合（busy 时由 manager 排队）
});

test('W4 queue-full：submit 拒收 ⇒ 队列满提示', async () => {
  const manager = new FakeManager();
  manager.submitResult = 'queue-full';
  const { handler, transport } = makeHandler(manager);
  handler.register();
  transport.downloadImpl = async () => ({ buffer: Buffer.from('x'), filename: 'a.png' });
  transport.emit(MEDIA());
  await flush();
  expect(transport.sent.at(-1)!.content).toContain('队列已满');
});
