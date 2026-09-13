import type { MediaKind } from '../media';

export type { MediaKind };

export interface ReplyRef { readonly __brand: 'ReplyRef'; readonly reqId: string }

export interface InboundTextMessage {
  msgid: string;
  chatType: 'single' | 'group';
  /** 仅群聊在场（SDK BaseMessage.chatid）；群帧缺失时 adapter 忽略该帧 */
  chatId?: string;
  userId: string;
  content: string;
  replyTo: ReplyRef;
}

/** enter_chat 事件（用户当日首次进入单聊——5s 欢迎窗由此起算，D5） */
export interface InboundEnterChat {
  msgid: string;
  chatType: 'single' | 'group';
  chatId?: string;
  userId: string;
  replyTo: ReplyRef;
}

/** feedback_event 事件（仅日志面，D5） */
export interface InboundFeedbackEvent {
  msgid: string;
  chatType: 'single' | 'group';
  chatId?: string;
  userId: string;
}

/** W4 入站媒体（单聊 image/file/voice/video——平台契约；url 5 分钟有效，per-link aeskey）。
 *  url/aeskey 均可选：缺失 = 协议异常帧（voice .d.ts 只声明 content 等）——仍上抛事件，
 *  由 handler 走 D8 错误面（never silent drop）；adapter 不得静默丢。 */
export interface InboundMediaMessage {
  msgid: string;
  chatType: 'single' | 'group';
  chatId?: string;
  userId: string;
  kind: MediaKind;
  url?: string;
  aeskey?: string;
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
  | { type: 'textMessage'; message: InboundTextMessage }
  | { type: 'enterChat'; message: InboundEnterChat }
  | { type: 'feedbackEvent'; message: InboundFeedbackEvent }
  | { type: 'mediaMessage'; message: InboundMediaMessage };

export type TransportHandler = (event: TransportEvent) => void;

export interface WeComTransport {
  start(): Promise<void>;          // 认证成功时 resolve；致命错误 reject
  stop(): Promise<void>;
  replyStream(ref: ReplyRef, streamId: string, content: string, finish: boolean): Promise<void>;
  /** enter_chat 欢迎语（aibot_respond_welcome_msg 通道，5s 窗内调用，D5） */
  replyWelcome(ref: ReplyRef, content: string): Promise<void>;
  /** W4：SDK 内建下载+解密端口（Q12——无自研 crypto）；过期 URL/解密失败原样 throw（D8 错误面） */
  downloadFile(url: string, aeskey?: string): Promise<{ buffer: Buffer; filename?: string }>;
  isConnected(): boolean;
  /** /status 数据面（D6/plan 评审 R1-F3）：连接双字段 */
  connectionStatus(): { connected: boolean; authenticated: boolean };
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
