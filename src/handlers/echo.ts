import { randomUUID } from 'node:crypto';
import type { ReplyRef, WeComTransport } from '../transport/types';
import type { BotLogger } from '../logger';

export class EchoHandler {
  constructor(private transport: WeComTransport, private logger: BotLogger) {}

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
      // feishubot #62：记录并传播语义——这里传播目标就是日志与状态面，不让进程崩
      this.logger.error('echo reply failed', { msgid, reqId: ref.reqId, err: (e as Error).message });
    }
  }
}
