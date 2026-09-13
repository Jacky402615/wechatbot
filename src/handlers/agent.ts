import { randomUUID } from 'node:crypto';
import type { WeComTransport, ReplyRef, InboundTextMessage, InboundEnterChat, InboundMediaMessage } from '../transport/types';
import type { BotLogger } from '../logger';
import type { AgentEvent, AgentEventHandler } from '../agent/manager';
import { TURN_ABORTED_ERROR } from '../agent/manager';
import { renderAskText, buildContextPreamble, truncateUtf8 } from '../agent/parser';
import { chatKeyOf } from '../agent/session-store';
import type { AccessGate, AccessSnapshot } from '../access';
import { parseCommand, stripMention, helpText, welcomeText, statusText, REJECTION_TEXT, type ParsedCommand } from '../commands';
import { MediaStore, attachmentNote, degradedNote, MAX_MEDIA_BYTES } from '../media';

const REFRESH_INTERVAL_MS = 2_000;      // ≤30 帧/分钟（D5）
const MAX_CONTENT_BYTES = 20_000;       // SDK 硬限 20480 − 余量（D5）
const RATE_PER_MINUTE = 30;
const RATE_PER_HOUR = 1_000;
const FINAL_WAIT_INTERVAL_MS = 1_000;   // 终帧限流等待的重试间隔
const FINAL_WAIT_MAX_TRIES = 25;        // ≤25s < 平台 10min 的 30s 安全边距——到顶即有界逃逸

export interface AgentManagerPort {
  submit(chatKey: string, chatType: 'single' | 'group', userId: string, prompt: string, onEvent: AgentEventHandler): string;
  answerPendingAsk(chatKey: string, text: string, answeringUserId?: string): Promise<'answered' | 'invalid_numeric' | 'none' | 'answerer-busy'>;
  hasPendingAsk(chatKey: string): boolean;
  expireStaleAsk(chatKey: string): boolean;
  abortChat(chatKey: string): { status: 'stopped' | 'stopping' | 'idle'; dropped: number };
  resetSession(chatKey: string): void;
  inFlightCount(): number;
  activeSessionCount(): { active: number; corrupt: number };
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
  if (error === TURN_ABORTED_ERROR) return '⏹ 已停止当前回合';
  if (error.includes('turn timeout')) return '⏱ 回合超时（10 分钟）已截断，请继续提问以重开会话';
  if (/spawn|ENOENT/i.test(error)) return '⚠️ claude 不可用，请联系管理员';
  return '⚠️ 处理失败，请稍后重试';
}

export class AgentHandler {
  private streams = new Map<string, TurnStream>();
  private limiter: ConversationRateLimiter;

  constructor(private deps: { transport: WeComTransport; logger: BotLogger; manager: AgentManagerPort; workspace: string; access: AccessGate; media: MediaStore; mentionName?: string }, private opts: AgentHandlerOptions = {}) {
    this.limiter = opts.rateLimiter ?? new ConversationRateLimiter();
  }

  register(): void {
    this.deps.transport.on((event) => {
      if (event.type === 'enterChat') {
        // 5s 硬路径（D5）：分层欢迎——同步 tier 判定后立即 replyWelcome，无前置 await
        this.onEnterChat(event.message).catch((e: unknown) => {
          this.deps.logger.error('welcome handling failed', { msgid: event.message.msgid, err: (e as Error).message });
        });
        return;
      }
      if (event.type === 'feedbackEvent') {
        this.deps.logger.info('feedback event', { msgid: event.message.msgid, userId: event.message.userId, chatType: event.message.chatType });
        return;
      }
      if (event.type === 'mediaMessage') {
        // C4 同构：入站媒体处理的意外失败必须可见 + 用户必有回声（criticalFinal 兜底）
        this.onMedia(event.message).catch((e: unknown) => {
          this.deps.logger.error('media handling failed', { msgid: event.message.msgid, err: (e as Error).message });
          this.opts.onReplyError?.(e as Error);
          if (event.message.chatType !== 'group') {
            void this.criticalFinal(event.message.replyTo, chatKeyOf(event.message), '⚠️ 处理失败，请稍后重试。')
              .catch(() => { /* 兜底帧失败已由 rawSend 留痕 */ });
          }
        });
        return;
      }
      if (event.type !== 'textMessage') return;
      // code-review C4：入站处理的意外失败必须可见（日志 + lastError），不冒 unhandled。
      // pr-review P3：源头用户不得无回声——兜底一次性「处理失败」终帧（预算耗尽即丢）。
      this.onText(event.message).catch((e: unknown) => {
        this.deps.logger.error('inbound handling failed', { msgid: event.message.msgid, err: (e as Error).message });
        this.opts.onReplyError?.(e as Error);
        try {
          if (event.message.chatType !== 'group' || event.message.chatId) {
            // pr-review R2-P3：源头兜底走**关键终帧**路径（有界等待 + 强制发送 + 记账），
            // 不得用可丢弃的 notice——失败面承诺是「用户必有回声」
            void this.criticalFinal(event.message.replyTo, chatKeyOf(event.message), '⚠️ 处理失败，请稍后重试。')
              .catch(() => { /* 兜底帧失败已由 rawSend 留痕 */ });
          }
        } catch { /* chatKeyOf 异常（理论不可达）——不再递归兜底 */ }
      });
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
    // 单帧单快照（plan 评审 R1-F2）：本帧全部判定共用同一 access 版本
    const snap = this.deps.access.load();
    let content = m.content;
    if (m.chatType === 'group') {
      // 群策略（D2/D3）：allowlist → rejected 静默 → @ 提及 token 边界匹配剥离
      if (!snap.groupAllowed(m.chatId!)) {
        this.deps.logger.debug('group not allow-listed, ignored', { msgid: m.msgid, chatId: m.chatId });
        return;
      }
      const tier = snap.tierOf(m.userId);
      if (tier === 'rejected') {
        this.deps.logger.warn('rejected sender in group ignored', { msgid: m.msgid, userId: m.userId });
        return;
      }
      const stripped = stripMention(m.content, this.deps.mentionName);
      if (stripped === null) {
        this.deps.logger.debug('group text without bot mention ignored', { msgid: m.msgid });
        return;
      }
      content = stripped;
      if (content.trim() === '') return;
    } else {
      const tier = snap.tierOf(m.userId);
      if (tier !== 'admin' && tier !== 'approved') {
        this.deps.logger.info('p2p sender not authorized', { msgid: m.msgid, userId: m.userId });
        await this.notice(m.replyTo, chatKey, REJECTION_TEXT);
        return;
      }
    }
    const cmd = parseCommand(content);
    if (cmd) {
      await this.dispatchCommand(cmd, m, chatKey, snap);
      return;
    }
    // 顺序硬约束（plan 评审 F4）：先判过期——过期 ask 绝不作答，入站按新回合处理
    if (this.deps.manager.expireStaleAsk(chatKey)) {
      const st = this.ensureStream(m.replyTo, chatKey);
      st.banner = `${st.banner}⚠️ 上一个问题已超时失效，已开启新会话\n\n`;
      st.ref = m.replyTo; // 过期后的新回合绑最新回调（F5）
    } else if (this.deps.manager.hasPendingAsk(chatKey)) {
      const r = await this.deps.manager.answerPendingAsk(chatKey, content, m.userId);
      if (r === 'answered') {
        const st = this.streams.get(chatKey);
        if (st && !st.closed) st.ref = m.replyTo; // 答复后的续输出绑作答回调（F5）
        return;
      }
      if (r === 'invalid_numeric') {
        await this.notice(m.replyTo, chatKey, '无效选项，请回复数字（如 1 或 1,3），或直接回复文字。');
        return; // ask 续流（this.streams 中的 pending 续流）不受影响（R2-F4）
      }
      if (r === 'answerer-busy') {
        // pr-review P1：作答者已达每用户帽——拒收并提示稍后重试（ask 保持 pending）
        await this.notice(m.replyTo, chatKey, '你当前进行中的会话已达上限（3），请稍后再回复选项作答。');
        return;
      }
      // 'none'：pending 已死——按新消息继续
    }
    const prompt = buildContextPreamble({ userId: m.userId, chatKey, chatType: m.chatType }) + content;
    const verdict = this.deps.manager.submit(chatKey, m.chatType, m.userId, prompt, (ev) => this.bridge(m.replyTo, chatKey, ev));
    if (verdict === 'queue-full') {
      await this.notice(m.replyTo, chatKey, '消息队列已满，请稍后再试。');
    }
    // 'queued'：不打扰——回合结束后的批回合回执（AC3）
  }

  /** 网关命令分派（D4/D6/D9/D10）——已过 gate；snap 为本帧 access 快照（R1-F2 同版本授权）。 */
  private async dispatchCommand(cmd: ParsedCommand, m: InboundTextMessage, chatKey: string, snap: AccessSnapshot): Promise<void> {
    this.deps.logger.info('command', { name: cmd.name, chatKey, userId: m.userId });
    switch (cmd.name) {
      case 'help':
        await this.notice(m.replyTo, chatKey, helpText());
        return;
      case 'new': {
        this.deps.manager.abortChat(chatKey);
        this.deps.manager.resetSession(chatKey);
        await this.notice(m.replyTo, chatKey, '🔄 已重置会话，下一条消息将开启全新对话。');
        return;
      }
      case 'stop': {
        const r = this.deps.manager.abortChat(chatKey);
        if (r.status === 'idle') {
          // stopped/stopping：不另发 ack——中止终帧（turn_failed→「已停止当前回合」）即回执（D4）
          await this.notice(m.replyTo, chatKey, r.dropped > 0 ? `已清空 ${r.dropped} 条排队消息；当前没有进行中的回合` : '当前没有进行中的回合');
        }
        return;
      }
      case 'status': {
        if (m.chatType !== 'single' || snap.tierOf(m.userId) !== 'admin') {
          await this.notice(m.replyTo, chatKey, '/status 仅管理员私聊可用。');
          return;
        }
        const conn = this.deps.transport.connectionStatus();
        const sessions = this.deps.manager.activeSessionCount();
        await this.notice(m.replyTo, chatKey, statusText({
          connected: conn.connected, authenticated: conn.authenticated,
          admins: snap.admin, approved: snap.approved, groups: snap.groups,
          activeSessions: sessions.active, corruptSessions: sessions.corrupt,
          inFlight: this.deps.manager.inFlightCount(),
        }));
        return;
      }
      default:
        await this.notice(m.replyTo, chatKey, `未知命令：/${cmd.name}\n\n${helpText()}`);
    }
  }

  /** W4 媒体编排（D4/D5/D8）：群守卫 → gate（未授权零下载）→ 过期 ask → 下载（5 分钟窗内立即）→
   *  落盘 → note → submit。媒体绝不喂 answerPendingAsk（不可能是数字/文字作答；pending 不因媒体失效）。 */
  private async onMedia(m: InboundMediaMessage): Promise<void> {
    if (m.chatType === 'group') {
      this.deps.logger.debug('group media ignored (platform single-chat only)', { msgid: m.msgid });
      return;
    }
    const chatKey = chatKeyOf(m);
    const snap = this.deps.access.load();
    const tier = snap.tierOf(m.userId);
    if (tier !== 'admin' && tier !== 'approved') {
      this.deps.logger.info('p2p media sender not authorized', { msgid: m.msgid, userId: m.userId });
      await this.notice(m.replyTo, chatKey, REJECTION_TEXT);
      return;
    }
    if (this.deps.manager.expireStaleAsk(chatKey)) {
      const st = this.ensureStream(m.replyTo, chatKey);
      st.banner = `${st.banner}⚠️ 上一个问题已超时失效，已开启新会话\n\n`;
      st.ref = m.replyTo;
    }
    // D8 协议异常面：长连接模式媒体恒加密——缺 aeskey 的密文不得当可解析附件落盘（SDK 无 key 原样返回密文）；
    // 缺 url 无法下载。两者与下载失败同面（AC4 关键终帧短错误），零下载、不 spawn。
    if (!m.url || !m.aeskey) {
      this.deps.logger.error('media frame missing url/aeskey', { msgid: m.msgid, kind: m.kind, hasUrl: !!m.url, hasAeskey: !!m.aeskey });
      await this.criticalFinal(m.replyTo, chatKey, '⚠️ 附件接收失败（下载超时或解密失败），请重新发送。');
      return;
    }
    let downloaded: { buffer: Buffer; filename?: string };
    try {
      downloaded = await this.deps.transport.downloadFile(m.url, m.aeskey); // D5：过 gate 即下载——排队不得吞噬 5 分钟窗
    } catch (e) {
      // D8：下载/解密失败 ⇒ 关键终帧短错误（AC4 硬保证——不走可丢弃 notice），不 spawn
      this.deps.logger.error('media download failed', { msgid: m.msgid, kind: m.kind, err: (e as Error).message });
      await this.criticalFinal(m.replyTo, chatKey, '⚠️ 附件接收失败（下载超时或解密失败），请重新发送。');
      return;
    }
    let note: string;
    if (downloaded.buffer.length === 0 || downloaded.buffer.length > MAX_MEDIA_BYTES) {
      const reason = downloaded.buffer.length === 0 ? 'empty' : 'oversize';
      this.deps.logger.warn('media degraded', { msgid: m.msgid, kind: m.kind, bytes: downloaded.buffer.length, reason });
      note = degradedNote(m.kind, reason);
    } else {
      try {
        const saved = this.deps.media.save(m.kind, m.msgid, downloaded.buffer, downloaded.filename);
        this.deps.logger.info('media saved', { msgid: m.msgid, kind: m.kind, path: saved.absPath, bytes: saved.bytes });
        note = attachmentNote(m.kind, saved.absPath, saved.bytes);
      } catch (e) {
        // D8：落盘失败 ⇒ 降级 note（回合照跑，绝不静默丢）
        this.deps.logger.error('media save failed', { msgid: m.msgid, kind: m.kind, err: (e as Error).message });
        note = degradedNote(m.kind, 'save-failed');
      }
    }
    const prompt = buildContextPreamble({ userId: m.userId, chatKey, chatType: m.chatType }) + note;
    const verdict = this.deps.manager.submit(chatKey, m.chatType, m.userId, prompt, (ev) => this.bridge(m.replyTo, chatKey, ev));
    if (verdict === 'queue-full') {
      await this.notice(m.replyTo, chatKey, '消息队列已满，请稍后再试。');
    }
  }

  /** enter_chat 分层欢迎（D5）：allowed → 欢迎+命令清单；rejected/unknown → 拒绝文案；
   *  群 enter_chat 忽略。发送失败留痕不影响消息面。 */
  private async onEnterChat(m: InboundEnterChat): Promise<void> {
    if (m.chatType !== 'single') {
      this.deps.logger.debug('group enter_chat ignored', { msgid: m.msgid });
      return;
    }
    const snap = this.deps.access.load();
    const tier = snap.tierOf(m.userId);
    const content = tier === 'admin' || tier === 'approved' ? welcomeText() : REJECTION_TEXT;
    try {
      await this.deps.transport.replyWelcome(m.replyTo, content);
    } catch (e) {
      this.deps.logger.error('welcome reply failed', { msgid: m.msgid, userId: m.userId, err: (e as Error).message });
    }
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
        // 问题渲染保底预算（plan 评审 R2-F4/F7 + code-review C6）：**问题清单先拿预算**，
        // 已产出文本用余量——长输出不得截掉编号清单（AC4）；ask 本身超上限时截断带标记（确定性）
        const askText = renderAskText(ev.questions);
        const SEP_BYTES = 2;
        const askBudget = Math.min(Buffer.byteLength(askText, 'utf8'), cap - SEP_BYTES);
        const accBudget = Math.max(cap - askBudget - SEP_BYTES, 0);
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
      case 'ask_expired': {
        // 无人作答的 TTL 过期（code-review C3）：续流尚未发出——主动发一条过期通知收口。
        // 只认领「处女续流」（无 banner/acc/已发帧——R2-C1：入站过期路径已把流让渡给
        // 新回合的 banner，绝不能删；新回合自己的流更不能被旧代事件误删）。
        this.deps.logger.warn('ask expired (ttl)', { chatKey });
        const pending = this.streams.get(chatKey);
        const virgin = pending && !pending.closed && !pending.acc && !pending.banner && pending.lastFrameAt === 0;
        if (pending && virgin) {
          this.streams.delete(chatKey);
          await this.notice(st.ref, chatKey, '⚠️ 上一个问题已超时失效。');
        }
        return;
      }
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

  /** 关键兜底终帧（pr-review R2-P3）：一次性流，不触碰 this.streams；
   *  与终帧同款限流语义——有界等待预算，到顶强制发送 + record 记账 + ERROR 告警（绝不丢弃）。
   *  键用已知 chatKey（ephemeral 流不在 streams 表内，send 的反查会退化成 reqId）。 */
  private async criticalFinal(ref: ReplyRef, chatKey: string, content: string): Promise<void> {
    const interval = this.opts.finalWaitIntervalMs ?? FINAL_WAIT_INTERVAL_MS;
    const maxTries = this.opts.finalWaitMaxTries ?? FINAL_WAIT_MAX_TRIES;
    let acquired = false;
    for (let i = 0; i < maxTries && !(acquired = this.limiter.tryAcquire(chatKey)); i++) {
      await new Promise((r) => setTimeout(r, interval));
    }
    if (!acquired) {
      this.limiter.record(chatKey);
      this.deps.logger.error('critical fallback sent over conversation rate limit (bounded escape)', { chatKey });
    }
    const st: TurnStream = { ref, streamId: randomUUID(), banner: '', acc: '', lastFrameAt: 0, closed: false, sendChain: Promise.resolve() };
    await this.rawSend(st, content, true);
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
