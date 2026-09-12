import { randomUUID } from 'node:crypto';
import type { ReplyRef, WeComTransport } from '../transport/types';
import type { BotLogger } from '../logger';

export interface EchoHandlerOptions {
  /** 回复失败回调（Gateway 借此持久化 lastError——错误必须传播，不吞） */
  onReplyError?: (err: Error) => void;
}

export class EchoHandler {
  constructor(
    private transport: WeComTransport,
    private logger: BotLogger,
    private opts: EchoHandlerOptions = {},
  ) {}

  register(): void {
    this.transport.on((event) => {
      if (event.type !== 'textMessage') return;
      if (event.message.chatType !== 'single') {
        this.logger.debug('echo skip non-single chat', { msgid: event.message.msgid, chatType: event.message.chatType });
        return;
      }
      void this.handle(event.message.msgid, event.message.content, event.message.replyTo);
    });
  }

  private async handle(msgid: string, content: string, ref: ReplyRef): Promise<void> {
    const streamId = randomUUID();
    try {
      await this.transport.replyStream(ref, streamId, content, true);
      this.logger.info('echo replied', { msgid, reqId: ref.reqId, streamId, finish: true });
    } catch (e) {
      const err = e as Error;
      // feishubot #62：记录并传播——onReplyError 把失败送进 Gateway 状态面（lastError）
      this.logger.error('echo reply failed', { msgid, reqId: ref.reqId, err: err.message });
      this.opts.onReplyError?.(err);
    }
  }
}
