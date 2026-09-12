import { WebSocketServer, WebSocket } from 'ws';

export interface MockFrame { cmd?: string; headers: { req_id: string }; body?: unknown }

export class MockWecomServer {
  sentFrames: MockFrame[] = [];
  subscribeTimes: number[] = [];   // 每次 aibot_subscribe 到达的 Date.now()——soak 量退避用
  private wss: WebSocketServer | null = null;
  private port = 0;
  private sockets = new Set<WebSocket>();
  private subscribes = 0;
  private pings = 0;

  constructor(private opts: { authErrcode?: number } = {}) {}

  /** 切换认证应答（测试"被踢后凭据失效"场景用） */
  setAuthErrcode(errcode: number): void { this.opts.authErrcode = errcode; }

  async start(): Promise<{ port: number; url: string }> {
    this.wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    this.wss.on('connection', (ws) => {
      this.sockets.add(ws);
      ws.on('message', (data) => {
        let frame: MockFrame;
        try { frame = JSON.parse(data.toString()) as MockFrame; } catch { return; }
        if (!frame?.headers?.req_id) return;
        if (frame.cmd === 'aibot_subscribe') {
          this.subscribes += 1;
          this.subscribeTimes.push(Date.now());
          const errcode = this.opts.authErrcode ?? 0;
          ws.send(JSON.stringify({ headers: { req_id: frame.headers.req_id }, errcode, errmsg: errcode === 0 ? 'ok' : 'bad secret' }));
          if (errcode !== 0) ws.close();
          return;
        }
        if (frame.cmd === 'ping') this.pings += 1;
        if (frame.cmd === 'aibot_respond_msg') this.sentFrames.push(frame);
        ws.send(JSON.stringify({ headers: { req_id: frame.headers.req_id }, errcode: 0, errmsg: 'ok' }));
      });
      ws.on('close', () => this.sockets.delete(ws));
    });
    await new Promise<void>((resolve) => this.wss!.once('listening', () => resolve()));
    this.port = (this.wss.address() as { port: number }).port;
    return { port: this.port, url: `ws://127.0.0.1:${this.port}` };
  }

  get subscribeCount(): number { return this.subscribes; }
  get pingCount(): number { return this.pings; }

  pushTextMessage(reqId: string, msg: { msgid: string; userId: string; content: string }): void {
    this.broadcast({
      cmd: 'aibot_msg_callback',
      headers: { req_id: reqId },
      body: {
        msgid: msg.msgid, aibotid: 'bot-mock', chattype: 'single',
        from: { userid: msg.userId }, msgtype: 'text', text: { content: msg.content },
        create_time: Math.floor(Date.now() / 1000),
      },
    });
  }

  kick(): void {
    this.broadcast({
      cmd: 'aibot_event_callback',
      headers: { req_id: `kick-${Date.now()}` },
      body: {
        msgid: `ev-${Date.now()}`, aibotid: 'bot-mock', chattype: 'single',
        from: { userid: 'server' }, msgtype: 'event',
        event: { eventtype: 'disconnected_event' },
      },
    });
    setTimeout(() => this.kill(), 50);
  }

  kill(): void {
    for (const ws of this.sockets) ws.terminate();
  }

  private broadcast(frame: unknown): void {
    const text = JSON.stringify(frame);
    for (const ws of this.sockets) if (ws.readyState === WebSocket.OPEN) ws.send(text);
  }

  async stop(): Promise<void> {
    for (const ws of this.sockets) ws.terminate();
    this.sockets.clear();
    const wss = this.wss;
    this.wss = null;
    if (!wss) return;
    await new Promise<void>((resolve) => {
      // bun 下 close() 与客户端关闭握手竞态时可能不回调——有界兜底
      const timer = setTimeout(resolve, 1000);
      wss.close(() => { clearTimeout(timer); resolve(); });
      // closeAllConnections: ws ≥8 运行时存在，@types/ws 尚未声明
      (wss as WebSocketServer & { closeAllConnections?: () => void }).closeAllConnections?.();
    });
  }
}
