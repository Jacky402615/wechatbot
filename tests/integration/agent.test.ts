import { test, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '../../src/gateway';
import { MockWecomServer } from '../helpers/mock-wecom-server';

const HELPER = join(import.meta.dir, '..', 'helpers', 'fake-claude.mjs');
const FAST = { reconnectInterval: 50, heartbeatInterval: 500, requestTimeout: 2000, resubscribeDelayMs: 150 };

async function waitUntil(cond: () => boolean, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitUntil timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function setup(scenario: string, agent: Record<string, unknown> = {}) {
  const ws = mkdtempSync(join(tmpdir(), 'wb-agent-'));
  const { loadWorkspace } = await import('../../src/config');
  loadWorkspace(ws);
  writeFileSync(join(ws, '.bot', '.env'), 'WECOM_BOT_ID=b\nWECOM_SECRET=s\n');
  const stateDir = join(ws, 'fake-state');
  mkdirSync(stateDir, { recursive: true });
  process.env.FAKE_CLAUDE_STATE_DIR = stateDir;
  process.env.FAKE_CLAUDE_SCENARIO = scenario;
  const srv = new MockWecomServer();
  const { url } = await srv.start();
  const { gateway } = await createGateway(ws, { wsUrl: url, ...FAST }, {
    claudeCommand: { command: process.execPath, argsPrefix: [HELPER] },
    refreshIntervalMs: 10,
    ...agent,
  });
  await gateway.start();
  return { ws, srv, gateway, stateDir };
}

interface StreamFrame { id: string; content: string; finish: boolean }
const streamsOf = (srv: MockWecomServer): StreamFrame[] =>
  srv.sentFrames.map((f) => (f.body as { stream?: StreamFrame }).stream!);

test('AC1：单聊文本往返流式回传，同 stream.id 刷新，终帧 finish=true', async () => {
  const { srv, gateway, stateDir } = await setup('deltas');
  srv.pushTextMessage('req-1', { msgid: 'm1', userId: 'u1', content: '你好' });
  await waitUntil(() => streamsOf(srv).some((s) => s.finish));
  const frames = streamsOf(srv);
  expect(new Set(frames.map((s) => s.id)).size).toBe(1);
  expect(frames.at(-1)!.finish).toBe(true);
  expect(frames.at(-1)!.content).toContain('第三段');
  expect(frames.length).toBeGreaterThanOrEqual(2); // 真实流式（≥1 刷新 + 终帧）
  const stdin = readFileSync(join(stateDir, 'stdin.jsonl'), 'utf8');
  expect(stdin).toContain('[Context: sender=u1, userid=u1, chat=u1 (p2p)]');
  await gateway.stop(); await srv.stop();
});

test('AC2：TTL 内 --resume 同会话；超 TTL 新会话', async () => {
  const { srv, gateway, stateDir } = await setup('happy', { idleTtlMs: 400 });
  srv.pushTextMessage('req-1', { msgid: 'm1', userId: 'u1', content: '第一回合' });
  await waitUntil(() => streamsOf(srv).some((s) => s.finish));
  srv.pushTextMessage('req-2', { msgid: 'm2', userId: 'u1', content: '第二回合' });
  await waitUntil(() => streamsOf(srv).filter((s) => s.finish).length === 2);
  const argv = readFileSync(join(stateDir, 'argv.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { resumeId: string | null });
  expect(argv[1]!.resumeId).not.toBeNull(); // TTL 内 resume
  await new Promise((r) => setTimeout(r, 600)); // 超 TTL
  srv.pushTextMessage('req-3', { msgid: 'm3', userId: 'u1', content: '第三回合' });
  await waitUntil(() => streamsOf(srv).filter((s) => s.finish).length === 3);
  const argv3 = readFileSync(join(stateDir, 'argv.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { resumeId: string | null });
  expect(argv3[2]!.resumeId).toBeNull(); // 过期 ⇒ fresh
  await gateway.stop(); await srv.stop();
});

test('AC3：两条急速消息串行排队，无交错流', async () => {
  const { srv, gateway, stateDir } = await setup('happy');
  srv.pushTextMessage('req-1', { msgid: 'm1', userId: 'u1', content: '第一条' });
  srv.pushTextMessage('req-2', { msgid: 'm2', userId: 'u1', content: '第二条' });
  await waitUntil(() => streamsOf(srv).filter((s) => s.finish).length === 2, 10_000);
  const frames = streamsOf(srv);
  // 严格无交错（R2-F6）：恰两条流；流2 首帧晚于流1 末帧；各自连续；各自 finish 收尾
  const ids = [...new Set(frames.map((f) => f.id))];
  expect(ids.length).toBe(2);
  const id1 = ids[0]!, id2 = ids[1]!;
  const firstOf2 = frames.findIndex((f) => f.id === id2);
  const lastOf1 = frames.map((f) => f.id).lastIndexOf(id1);
  expect(firstOf2).toBeGreaterThan(lastOf1);              // 流2 开始于流1 结束之后
  expect(frames.slice(0, firstOf2).every((f) => f.id === id1)).toBe(true); // 流1 连续
  expect(frames.slice(firstOf2).every((f) => f.id === id2)).toBe(true);    // 流2 连续
  expect(frames[lastOf1]!.finish).toBe(true);
  expect(frames.at(-1)!.finish).toBe(true);
  const stdin = readFileSync(join(stateDir, 'stdin.jsonl'), 'utf8');
  expect(stdin).toContain('第一条');
  expect(stdin).toContain('第二条'); // 第二回合 = 单条排队消息的原样续跑（无框架文本）
  await gateway.stop(); await srv.stop();
});

test('AC4：ask 渲染编号清单，数字作答后续输出新流收尾 finish=true', async () => {
  const { srv, gateway } = await setup('ask');
  srv.pushTextMessage('req-1', { msgid: 'm1', userId: 'u1', content: '开始' });
  await waitUntil(() => streamsOf(srv).some((s) => s.finish && /1\. 甲/.test(s.content)));
  const askFrame = streamsOf(srv).find((s) => /1\. 甲/.test(s.content))!;
  expect(askFrame.content).toContain('2. 乙');
  srv.pushTextMessage('req-2', { msgid: 'm2', userId: 'u1', content: '2' });
  await waitUntil(() => streamsOf(srv).filter((s) => s.finish).length === 2, 10_000);
  const finalFrame = streamsOf(srv).at(-1)!;
  expect(finalFrame.finish).toBe(true);
  expect(finalFrame.content).toContain('已收到选择');
  expect(finalFrame.id).not.toBe(askFrame.id); // 答复后新流（D7）
  await gateway.stop(); await srv.stop();
});

test('AC4 多选端到端：ask-multi 渲染 4 选项，回复 1,3 映射回 control_response，续流另起新 stream', async () => {
  const { srv, gateway, stateDir } = await setup('ask-multi');
  srv.pushTextMessage('req-1', { msgid: 'm1', userId: 'u1', content: '开始' });
  await waitUntil(() => streamsOf(srv).some((s) => s.finish && /1\. bun/.test(s.content)));
  const askFrame = streamsOf(srv).find((s) => /1\. bun/.test(s.content))!;
  expect(askFrame.content).toContain('4. 不要'); // 扁平编号 1..4
  srv.pushTextMessage('req-2', { msgid: 'm2', userId: 'u1', content: '1,3' });
  await waitUntil(() => streamsOf(srv).filter((s) => s.finish).length === 2, 10_000);
  const finalFrame = streamsOf(srv).at(-1)!;
  expect(finalFrame.content).toContain('已收到选择');
  expect(finalFrame.id).not.toBe(askFrame.id);
  const responses = readFileSync(join(stateDir, 'stdin.jsonl'), 'utf8').trim().split('\n')
    .map((l) => JSON.parse(l) as { type: string; response?: { response?: { updatedInput?: { answers?: Record<string, string> } } } })
    .filter((l) => l.type === 'control_response');
  expect(responses[0]!.response!.response!.updatedInput!.answers).toEqual({ '用哪个库？': 'bun', '要不要日志？': '要' });
  await gateway.stop(); await srv.stop();
});

test('AC5：无输出超时回合干净收流（压缩 turnTimeoutMs），子进程确已终止', async () => {
  const { srv, gateway, stateDir } = await setup('no-output', { turnTimeoutMs: 400 });
  srv.pushTextMessage('req-1', { msgid: 'm1', userId: 'u1', content: '慢' });
  await waitUntil(() => streamsOf(srv).some((s) => s.finish), 10_000);
  const f = streamsOf(srv).at(-1)!;
  expect(f.finish).toBe(true);
  expect(f.content).toContain('⏱ 回合超时');
  // pr-review P5：终止证据——超时杀掉的儿子进程已死（kill(pid,0) 抛 ESRCH）
  const argvs = readFileSync(join(stateDir, 'argv.jsonl'), 'utf8').trim().split('\n')
    .map((l) => JSON.parse(l) as { pid: number });
  const t0 = Date.now();
  let alive = argvs.map((a) => a.pid);
  while (alive.length > 0 && Date.now() - t0 < 3_000) {
    alive = alive.filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
    if (alive.length > 0) await new Promise((r) => setTimeout(r, 100));
  }
  expect(alive).toEqual([]);
  await gateway.stop(); await srv.stop();
});

test('群聊路径：chatid 定址会话，群消息往返', async () => {
  const { srv, gateway, stateDir } = await setup('happy');
  srv.pushTextMessage('req-g', { msgid: 'g1', userId: 'u1', content: '群消息', chatType: 'group', chatid: 'wrGrp' });
  await waitUntil(() => streamsOf(srv).some((s) => s.finish));
  expect(streamsOf(srv).at(-1)!.finish).toBe(true);
  const stdin = readFileSync(join(stateDir, 'stdin.jsonl'), 'utf8');
  expect(stdin).toContain('[Context: sender=u1, userid=u1, chat=wrGrp (group)]');
  await gateway.stop(); await srv.stop();
});
