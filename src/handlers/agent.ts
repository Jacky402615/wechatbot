import { randomUUID } from 'node:crypto';
import type { WeComTransport, ReplyRef, InboundTextMessage } from '../transport/types';
import type { BotLogger } from '../logger';
import type { AgentEvent, AgentEventHandler } from '../agent/manager';
import { renderAskText, buildContextPreamble, truncateUtf8 } from '../agent/parser';
import { chatKeyOf } from '../agent/session-store';

const REFRESH_INTERVAL_MS = 2_000;      // ≤30 帧/分钟（D5）
const MAX_CONTENT_BYTES = 20_000;       // SDK 硬限 20480 − 余量（D5）
const RATE_PER_MINUTE = 30;
const RATE_PER_HOUR = 1_000;
const FINAL_WAIT_INTERVAL_MS = 1_000;   // 终帧限流等待的重试间隔
const FINAL_WAIT_MAX_TRIES = 25;        // ≤25s < 平台 10min 的 30s 安全边距——到顶即有界逃逸

export interface AgentManagerPort {
  submit(chatKey: string, chatType: 'single' | 'group', userId: string, prompt: string, onEvent: AgentEventHandler): string;
  answerPendingAsk(chatKey: string, text: string, answeringUserId?: string): 'answered' | 'invalid_numeric' | 'none';
  hasPendingAsk(chatKey: string): boolean;
  expireStaleAsk(chatKey: string): boolean;
  closeAll(): Promise<void>;
}

/** 会话级限流：30 msg/min 与 1000/h 双滑窗（平台护栏 reply+proactive 合并口径）。
 *  刷新/通知帧预算耗尽即丢（刷新幂等、通知非关键）；终帧在 send() 内有界等待预算，
 *  到顶才强制发送并 record() 逃逸记账（超限可见：后续帧预算更紧 + ERROR 日志）——
 *  孤儿流仍比静默超限更糟，但账面不撒谎（D5 修订，plan 评审 R2-F1/R3-F1）。 */
export class ConversationRateLimiter {
  private windows = new Map<string, { min: number[]; hour: number[] }>();
  constructor(private opts: { perMinute?: number; perHour?: number; now?: () => number } = {}) {}
  tryAcquire(key: string): boolean {
    const now = this.opts.now ? this.opts.now() : Date.now();
    const w = this.prune(key, now);
    const perMin = this.opts.perMinute ?? RATE_PER_MINUTE;
    const perHour = this.opts.perHour ?? RATE_PER_HOUR;
    if (w.min.length >= perMin || w.hour.length >= perHour) {
      this.windows.set(key, w);
      return false;
    }
    w.min.push(now); w.hour.push(now);
    this.windows.set(key, w);
    return true;
  }
  /** 逃逸记账：强行发送的终帧也进窗口（诚实超限——不悄悄绕过护栏）。 */
  record(key: string): void {
    const now = this.opts.now ? this.opts.now() : Date.now();
    const w = this.prune(key, now);
    w.min.push(now); w.hour.push(now);
    this.windows.set(key, w);
  }
  private prune(key: string, now: number): { min: number[]; hour: number[] } {
    const w = this.windows.get(key) ?? { min: [], hour: [] };
    w.min = w.min.filter((t) => now - t < 60_000);
    w.hour = w.hour.filter((t) => now - t < 3_600_000);
    return w;
  }
}

interface TurnStream {
  ref: ReplyRef; streamId: string; banner: string; acc: string;
  lastFrameAt: number; closed: boolean;
  sendChain: Promise<void>;   // 每 chat 串行发送（F9：全量快照帧不得乱序）
}

export interface AgentHandlerOptions {
  onReplyError?: (err: Error) => void;
  refreshIntervalMs?: number;
  maxContentBytes?: number;
  /** 测试注入：限流器（假时钟）与终帧等待节奏（R3-F1 确定性覆盖） */
  rateLimiter?: ConversationRateLimiter;
  finalWaitIntervalMs?: number;
  finalWaitMaxTries?: number;
}

function userFacingError(error: string): string {
  if (error.includes('turn timeout')) return '⏱ 回合超时（10 分钟）已截断，请继续提问以重开会话';
  if (/spawn|ENOENT/i.test(error)) return '⚠️ claude 不可用，请联系管理员';
  return '⚠️ 处理失败，请稍后重试';
}

export class AgentHandler {
  private streams = new Map<string, TurnStream>();
  private limiter: ConversationRateLimiter;

  constructor(private deps: { transport: WeComTransport; logger: BotLogger; manager: AgentManagerPort; workspace: string }, private opts: AgentHandlerOptions = {}) {
    this.limiter = opts.rateLimiter ?? new ConversationRateLimiter();
  }

  register(): void {
    this.deps.transport.on((event) => {
      if (event.type !== 'textMessage') return;
      void this.onText(event.message);
    });
  }

  async stop(): Promise<void> {
    await this.deps.manager.closeAll();
    this.streams.clear();
  }

  private async onText(m: InboundTextMessage): Promise<void> {
    if (m.chatType === 'group' && !m.chatId) {
      this.deps.logger.debug('group text without chatId ignored', { msgid: m.msgid });
      return;
    }
    const chatKey = chatKeyOf(m);
    // 顺序硬约束（plan 评审 F4）：先判过期——过期 ask 绝不作答，入站按新回合处理
    if (this.deps.manager.expireStaleAsk(chatKey)) {
      const st = this.ensureStream(m.replyTo, chatKey);
      st.banner = `${st.banner}⚠️ 上一个问题已超时失效，已开启新会话\n\n`;
      st.ref = m.replyTo; // 过期后的新回合绑最新回调（F5）
    } else if (this.deps.manager.hasPendingAsk(chatKey)) {
      const r = this.deps.manager.answerPendingAsk(chatKey, m.content, m.userId);
      if (r === 'answered') {
        const st = this.streams.get(chatKey);
        if (st && !st.closed) st.ref = m.replyTo; // 答复后的续输出绑作答回调（F5）
        return;
      }
      if (r === 'invalid_numeric') {
        await this.notice(m.replyTo, chatKey, '无效选项，请回复数字（如 1 或 1,3），或直接回复文字。');
        return; // ask 续流（this.streams 中的 pending 续流）不受影响（R2-F4）
      }
      // 'none'：pending 已死——按新消息继续
    }
    const prompt = buildContextPreamble({ userId: m.userId, chatKey, chatType: m.chatType }) + m.content;
    const verdict = this.deps.manager.submit(chatKey, m.chatType, m.userId, prompt, (ev) => this.bridge(m.replyTo, chatKey, ev));
    if (verdict === 'queue-full') {
      await this.notice(m.replyTo, chatKey, '消息队列已满，请稍后再试。');
    }
    // 'queued'：不打扰——回合结束后的批回合回执（AC3）
  }

  private async bridge(ref: ReplyRef, chatKey: string, ev: AgentEvent): Promise<void> {
    const st = this.ensureStream(ref, chatKey);
    const cap = this.opts.maxContentBytes ?? MAX_CONTENT_BYTES;
    switch (ev.type) {
      case 'text_delta':
        st.acc += ev.text;
        await this.maybeRefresh(chatKey);
        return;
      case 'ask': {
        // 问题渲染保底预算（plan 评审 R2-F4/F7）：先截已产出文本，问题清单拿独立余量
        const askText = renderAskText(ev.questions);
        const askBudget = Math.min(Buffer.byteLength(askText, 'utf8'), Math.max(cap - 200, Math.floor(cap / 2)));
        const accBudget = Math.max(cap - askBudget - 16, 0);
        const head = st.acc ? `${truncateUtf8(st.banner + st.acc, accBudget)}\n\n` : st.banner;
        const content = truncateUtf8(head + askText, cap);
        await this.send(st, content, true); // 闭流（D7 生命周期）
        this.streams.set(chatKey, { ref: st.ref, streamId: randomUUID(), banner: '', acc: '', lastFrameAt: 0, closed: false, sendChain: Promise.resolve() }); // 答复后新流
        return;
      }
      case 'turn_complete': {
        const content = `${st.banner}${st.acc}` || '（无输出）';
        await this.send(st, truncateUtf8(content, cap), true);
        this.streams.delete(chatKey);
        return;
      }
      case 'turn_failed': {
        const content = `${st.banner}${st.acc}${st.acc ? '\n\n' : ''}${userFacingError(ev.error)}`;
        try {
          await this.send(st, truncateUtf8(content, cap), true);
        } finally {
          this.deps.logger.error('turn failed', { chatKey, error: ev.error });
          this.opts.onReplyError?.(new Error(ev.error));
        }
        this.streams.delete(chatKey);
        return;
      }
      case 'ask_expired':
        // 过期通知由 onText 的 banner 路径承载——本事件只作日志锚点
        this.deps.logger.warn('ask expired', { chatKey });
        return;
    }
  }

  private ensureStream(ref: ReplyRef, chatKey: string): TurnStream {
    let st = this.streams.get(chatKey);
    if (!st || st.closed) {
      st = { ref, streamId: randomUUID(), banner: '', acc: '', lastFrameAt: 0, closed: false, sendChain: Promise.resolve() };
      this.streams.set(chatKey, st);
    }
    return st;
  }

  private async maybeRefresh(chatKey: string): Promise<void> {
    const st = this.streams.get(chatKey);
    if (!st || st.closed) return;
    const interval = this.opts.refreshIntervalMs ?? REFRESH_INTERVAL_MS;
    const now = Date.now();
    if (now - st.lastFrameAt < interval) return;
    if (!this.limiter.tryAcquire(chatKey)) return; // 预算耗尽丢刷新——幂等无损（D5）
    st.lastFrameAt = now;
    st.sendChain = st.sendChain.then(() => this.rawSend(st!, truncateUtf8(st!.banner + st!.acc, this.opts.maxContentBytes ?? MAX_CONTENT_BYTES), false));
    await st.sendChain;
  }

  /** 通知帧（队列满/无效选项提示）：一次性流，**不触碰 this.streams**（plan 评审 R2-F4：
   *  替换活动流会孤儿化运行中回合的流），预算耗尽即丢（非关键，debug 留痕）。 */
  private async notice(ref: ReplyRef, chatKey: string, content: string): Promise<void> {
    if (!this.limiter.tryAcquire(chatKey)) {
      this.deps.logger.debug('notice dropped by rate limiter', { chatKey });
      return;
    }
    const ephemeral: TurnStream = { ref, streamId: randomUUID(), banner: '', acc: '', lastFrameAt: 0, closed: false, sendChain: Promise.resolve() };
    await this.rawSend(ephemeral, content, true);
  }

  /** 终帧发送：有界等待限流预算（≤25s）；到顶强制发送 + record() 记账 + ERROR 告警（D5 修订）。 */
  private async send(st: TurnStream, content: string, finish: boolean): Promise<void> {
    if (finish) {
      const chatKey = this.chatKeyOfStream(st);
      const interval = this.opts.finalWaitIntervalMs ?? FINAL_WAIT_INTERVAL_MS;
      const maxTries = this.opts.finalWaitMaxTries ?? FINAL_WAIT_MAX_TRIES;
      let acquired = false;
      for (let i = 0; i < maxTries && !(acquired = this.limiter.tryAcquire(chatKey)); i++) {
        await new Promise((r) => setTimeout(r, interval));
      }
      if (!acquired) {
        this.limiter.record(chatKey); // 诚实超限：逃逸帧也进窗口
        this.deps.logger.error('final frame sent over conversation rate limit (bounded escape)', { chatKey });
      }
    }
    st.sendChain = st.sendChain.then(() => this.rawSend(st, content, finish));
    await st.sendChain;
  }

  private chatKeyOfStream(st: TurnStream): string {
    for (const [k, v] of this.streams) if (v === st) return k;
    return st.ref.reqId;
  }

  private async rawSend(st: TurnStream, content: string, finish: boolean): Promise<void> {
    try {
      await this.deps.transport.replyStream(st.ref, st.streamId, content, finish);
      if (finish) st.closed = true;
    } catch (e) {
      const err = e as Error;
      this.deps.logger.error('reply stream failed', { reqId: st.ref.reqId, err: err.message, finish });
      if (finish) st.closed = true; // 终帧失败也闭——不重试（错误已上抛状态面）
      this.opts.onReplyError?.(err);
    }
  }
}
