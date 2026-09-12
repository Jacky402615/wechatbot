import { WSClient, WSAuthFailureError, type WsFrame, type WsFrameHeaders } from '@wecom/aibot-node-sdk';
import type {
  InboundTextMessage, ReplyRef, TransportEvent, TransportHandler, TransportOptions, WeComTransport,
} from './types';

export type { InboundTextMessage, ReplyRef, TransportEvent, TransportHandler, TransportOptions, WeComTransport };

const START_TIMEOUT_MS = 30_000;
const DEFAULT_RESUBSCRIBE_DELAY_MS = 5_000;

export class WecomSdkTransport implements WeComTransport {
  private client: WSClient | null = null;
  private handlers: TransportHandler[] = [];
  private stopped = false;
  private resubscribeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private opts: TransportOptions) {}

  async start(): Promise<void> {
    this.stopped = false;
    const client = new WSClient({
      botId: this.opts.botId,
      secret: this.opts.secret,
      wsUrl: this.opts.wsUrl,
      heartbeatInterval: this.opts.heartbeatInterval,
      maxReconnectAttempts: this.opts.maxReconnectAttempts ?? -1,
      maxAuthFailureAttempts: this.opts.maxAuthFailureAttempts,
      reconnectInterval: this.opts.reconnectInterval,
      requestTimeout: this.opts.requestTimeout,
      // SDK 1.0.7 实测：不传 logger 时内部 this.logger 为 undefined，connect() 即崩
      logger: this.opts.logger ?? fallbackSdkLogger,
    });
    this.client = client;
    let settled = false;

    return new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        settled = true;
        try { client.disconnect(); } catch { /* 已断开 */ }
      };
      const timer = setTimeout(() => {
        if (settled) return;
        cleanup();
        reject(new Error(`transport start timeout after ${START_TIMEOUT_MS}ms (subscribe not confirmed)`));
      }, START_TIMEOUT_MS);
      const fail = (err: Error): void => {
        if (settled) return;
        cleanup();
        reject(err);
      };
      client.on('authenticated', () => {
        if (settled) { this.emit({ type: 'authenticated' }); return; }
        clearTimeout(timer);
        settled = true;
        this.emit({ type: 'authenticated' });
        resolve();
      });
      client.on('connected', () => this.emit({ type: 'connected' }));
      client.on('disconnected', (reason: string) => this.emit({ type: 'disconnected', reason }));
      client.on('reconnecting', (attempt: number) => this.emit({ type: 'reconnecting', attempt }));
      client.on('error', (err: Error) => {
        this.emit({ type: 'error', error: err });
        if (isFatalAuthError(err)) {
          fail(new Error(`subscribe failed: ${err.message}`, { cause: err }));
        }
      });
      client.on('message.text', (frame: WsFrame) => {
        const body = frame.body as unknown as {
          msgid: string; chattype?: 'single' | 'group'; from: { userid: string }; text: { content: string };
        };
        this.emit({
          type: 'textMessage',
          message: {
            msgid: body.msgid,
            chatType: body.chattype ?? 'single',
            userId: body.from?.userid ?? 'unknown',
            content: body.text?.content ?? '',
            replyTo: refFromFrame(frame),
          },
        });
      });
      client.on('event.disconnected_event', () => {
        this.emit({ type: 'kicked' });
        // SDK 1.0.7 实测：被踢路径置 isManualClose=true，SDK 不会自动重连——
        // adapter 延迟自愈（重新订阅），延迟用于避免与顶替者互相踢
        this.scheduleResubscribe();
      });
      client.connect();
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.resubscribeTimer) {
      clearTimeout(this.resubscribeTimer);
      this.resubscribeTimer = null;
    }
    this.teardownClient();
  }

  private scheduleResubscribe(): void {
    if (this.stopped || this.resubscribeTimer) return;
    const delay = this.opts.resubscribeDelayMs ?? DEFAULT_RESUBSCRIBE_DELAY_MS;
    this.resubscribeTimer = setTimeout(() => {
      this.resubscribeTimer = null;
      void this.resubscribe();
    }, delay);
  }

  private async resubscribe(): Promise<void> {
    if (this.stopped) return;
    this.teardownClient();
    try {
      await this.start();
    } catch (e) {
      const err = e as Error;
      this.emit({ type: 'error', error: err });
      if (isFatalAuthError(err)) {
        // 自愈期认证耗尽：致命——上报 fatal 让宿主进程响亮退出，而不是挂着空转
        this.emit({ type: 'fatal', error: err });
      } else {
        this.scheduleResubscribe();
      }
    }
  }

  private teardownClient(): void {
    try {
      this.client?.disconnect();
    } catch (e) {
      this.emit({ type: 'error', error: e as Error });
    }
    this.client = null;
  }

  async replyStream(ref: ReplyRef, streamId: string, content: string, finish: boolean): Promise<void> {
    if (!this.client) throw new Error('transport not started');
    const frame: WsFrameHeaders = { headers: { req_id: ref.reqId } };
    const receipt = await this.client.replyStream(frame, streamId, content, finish);
    if (receipt.errcode !== undefined && receipt.errcode !== 0) {
      throw new Error(`replyStream rejected: errcode=${receipt.errcode} errmsg=${receipt.errmsg}`);
    }
  }

  isConnected(): boolean {
    return this.client?.isConnected ?? false;
  }

  on(handler: TransportHandler): void {
    this.handlers.push(handler);
  }

  emitTestError(err: Error): void {
    this.emit({ type: 'error', error: err });
  }

  private emit(event: TransportEvent): void {
    for (const h of this.handlers) {
      try {
        h(event);
      } catch (e) {
        process.stderr.write(`transport handler crashed: ${(e as Error).message}\n`);
      }
    }
  }
}

function refFromFrame(frame: WsFrame): ReplyRef {
  return { __brand: 'ReplyRef', reqId: frame.headers?.req_id ?? '' };
}

const fallbackSdkLogger = {
  debug: (m: string) => console.debug(`[wecom-sdk] ${m}`),
  info: (m: string) => console.log(`[wecom-sdk] ${m}`),
  warn: (m: string) => console.warn(`[wecom-sdk] ${m}`),
  error: (m: string) => console.error(`[wecom-sdk] ${m}`),
};

/** 认证耗尽是致命错误：直接命中或作为 wrapped cause 出现都算（resubscribe 与 start 共用判定） */
function isFatalAuthError(err: Error): boolean {
  if (err instanceof WSAuthFailureError) return true;
  const code = (err as { code?: string }).code;
  if (code === 'WS_AUTH_FAILURE_EXHAUSTED') return true;
  const cause = (err as { cause?: unknown }).cause;
  return cause instanceof Error && isFatalAuthError(cause);
}
