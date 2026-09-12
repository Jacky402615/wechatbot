export interface ReplyRef { readonly __brand: 'ReplyRef'; readonly reqId: string }

export interface InboundTextMessage {
  msgid: string;
  chatType: 'single' | 'group';
  userId: string;
  content: string;
  replyTo: ReplyRef;
}

export type TransportEvent =
  | { type: 'connected' }
  | { type: 'authenticated' }
  | { type: 'disconnected'; reason: string }
  | { type: 'reconnecting'; attempt: number }
  | { type: 'error'; error: Error }
  | { type: 'fatal'; error: Error }
  | { type: 'kicked' }
  | { type: 'textMessage'; message: InboundTextMessage };

export type TransportHandler = (event: TransportEvent) => void;

export interface WeComTransport {
  start(): Promise<void>;          // 认证成功时 resolve；致命错误 reject
  stop(): Promise<void>;
  replyStream(ref: ReplyRef, streamId: string, content: string, finish: boolean): Promise<void>;
  isConnected(): boolean;
  on(handler: TransportHandler): void;
}

export interface TransportOptions {
  botId: string;
  secret: string;
  wsUrl?: string;                   // 测试与高级部署用；默认官方 wss://
  heartbeatInterval?: number;
  maxReconnectAttempts?: number;
  maxAuthFailureAttempts?: number;
  reconnectInterval?: number;
  requestTimeout?: number;          // SDK 请求超时（ms），测试压缩用
  resubscribeDelayMs?: number;      // 被踢后 adapter 重新订阅的延迟（防踢战），默认 5000
  logger?: { debug(m: string, ...a: unknown[]): void; info(m: string, ...a: unknown[]): void; warn(m: string, ...a: unknown[]): void; error(m: string, ...a: unknown[]): void };
}
