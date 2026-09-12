import { test, expect } from 'bun:test';
import WebSocket from 'ws';
import { MockWecomServer } from '../helpers/mock-wecom-server';

test('mock 服务端：subscribe 得 ack，ping 得 ack，respond 帧被记录', async () => {
  const srv = new MockWecomServer();
  const { url } = await srv.start();
  const ws = new WebSocket(url);
  const got: Array<Record<string, unknown>> = [];
  const reqIdOf = (f: Record<string, unknown>): string | undefined =>
    (f['headers'] as { req_id?: string } | undefined)?.['req_id'];
  ws.on('message', (d) => got.push(JSON.parse(d.toString())));
  await new Promise<void>((r) => ws.once('open', () => r()));
  const send = (f: unknown) => ws.send(JSON.stringify(f));

  send({ cmd: 'aibot_subscribe', headers: { req_id: 'r1' }, body: { bot_id: 'b', secret: 's' } });
  await waitUntil(() => got.some((f) => reqIdOf(f) === 'r1'));
  expect(got.find((f) => reqIdOf(f) === 'r1')).toEqual(expect.objectContaining({ errcode: 0 }));

  send({ cmd: 'ping', headers: { req_id: 'r2' } });
  send({ cmd: 'aibot_respond_msg', headers: { req_id: 'r3' }, body: { msgtype: 'stream', stream: { id: 's1', content: 'x', finish: true } } });
  await waitUntil(() => srv.sentFrames.length === 1);
  expect(srv.sentFrames[0]!.cmd).toBe('aibot_respond_msg');
  expect(srv.subscribeCount).toBe(1);
  ws.close();
  await srv.stop();
});

async function waitUntil(cond: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitUntil timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}
