import { test, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync, readdirSync, existsSync, readFileSync } from 'node:fs';
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

/** agent.test.ts setup 的 W3 扩展：access.json 可写 + groupMentionName 可配 */
async function setupCmd(access: unknown, cfg: Record<string, unknown> = {}, scenario = 'happy') {
  const ws = mkdtempSync(join(tmpdir(), 'wb-cmd-'));
  const { loadWorkspace } = await import('../../src/config');
  loadWorkspace(ws);
  writeFileSync(join(ws, '.bot', '.env'), 'WECOM_BOT_ID=b\nWECOM_SECRET=s\n');
  writeFileSync(join(ws, '.bot', 'access.json'), JSON.stringify(access) + '\n');
  if (Object.keys(cfg).length > 0) {
    writeFileSync(join(ws, '.bot', 'config.json'), JSON.stringify({ logLevel: 'info', ...cfg }, null, 2) + '\n');
  }
  const stateDir = join(ws, 'fake-state');
  mkdirSync(stateDir, { recursive: true });
  process.env.FAKE_CLAUDE_STATE_DIR = stateDir;
  process.env.FAKE_CLAUDE_SCENARIO = scenario;
  const srv = new MockWecomServer();
  const { url } = await srv.start();
  const { gateway } = await createGateway(ws, { wsUrl: url, ...FAST }, {
    claudeCommand: { command: process.execPath, argsPrefix: [HELPER] }, refreshIntervalMs: 10,
  });
  await gateway.start();
  return { ws, srv, gateway, stateDir };
}

interface StreamFrame { id: string; content: string; finish: boolean }
const streamsOf = (srv: MockWecomServer): StreamFrame[] =>
  srv.sentFrames.map((f) => (f.body as { stream?: StreamFrame }).stream!).filter(Boolean);
const textOf = (srv: MockWecomServer): string[] => streamsOf(srv).map((s) => s.content);
const argvLog = (stateDir: string) =>
  readFileSync(join(stateDir, 'argv.jsonl'), 'utf8').trim().split('\n')
    .map((l) => JSON.parse(l) as { resumeId: string | null; pid: number });
const activeSessions = (ws: string): number =>
  readdirSync(join(ws, '.bot', 'sessions'))
    .filter((f) => f.endsWith('.json'))
    .filter((f) => (JSON.parse(readFileSync(join(ws, '.bot', 'sessions', f), 'utf8')) as { status?: string }).status === 'active').length;

test('AC1：四命令端到端——全部应答、零 spawn（无 stdin.jsonl）', async () => {
  const { srv, gateway, stateDir, ws } = await setupCmd({ admin: ['boss'], approved: ['u1'] });
  srv.pushTextMessage('rq1', { msgid: 'c1', userId: 'u1', content: '/help' });
  srv.pushTextMessage('rq2', { msgid: 'c2', userId: 'u1', content: '/stop' });
  srv.pushTextMessage('rq3', { msgid: 'c3', userId: 'u1', content: '/new' });
  srv.pushTextMessage('rq4', { msgid: 'c4', userId: 'boss', content: '/status' });
  await waitUntil(() => streamsOf(srv).filter((s) => s.finish).length === 4);
  const texts = textOf(srv).join('\n--\n');
  expect(texts).toContain('/new');
  expect(texts).toContain('当前没有进行中的回合');
  expect(texts).toContain('已重置会话');
  expect(texts).toContain('网关状态');
  expect(texts).toContain('boss');
  expect(existsSync(join(stateDir, 'stdin.jsonl'))).toBe(false);       // 命令从不进 agent
  expect(readdirSync(join(ws, '.bot', 'sessions')).length).toBe(0);    // 无会话生成
  await gateway.stop(); await srv.stop();
});

test('AC2：陌生人 p2p——拒绝文案、无会话、无 spawn', async () => {
  const { srv, gateway, stateDir, ws } = await setupCmd({ approved: ['u1'] });
  srv.pushTextMessage('rq1', { msgid: 's1', userId: 'stranger', content: '你好' });
  srv.pushTextMessage('rq2', { msgid: 's2', userId: 'stranger', content: '/help' }); // 命令也只得拒绝
  await waitUntil(() => streamsOf(srv).filter((s) => s.finish).length === 2);
  for (const t of textOf(srv)) expect(t).toContain('未被授权');
  expect(existsSync(join(stateDir, 'stdin.jsonl'))).toBe(false);
  expect(readdirSync(join(ws, '.bot', 'sessions')).length).toBe(0);
  await gateway.stop(); await srv.stop();
});

test('AC3：listed 群 @ 路由群会话；非 listed 群/无 @ 忽略', async () => {
  const { srv, gateway, stateDir, ws } = await setupCmd({ groups: ['g1'] }, { groupMentionName: '小助手' });
  srv.pushTextMessage('rg1', { msgid: 'gm1', userId: 'member1', chatType: 'group', chatid: 'g1', content: '@小助手 群里问个问题' });
  await waitUntil(() => streamsOf(srv).some((s) => s.finish));
  const stdin = readFileSync(join(stateDir, 'stdin.jsonl'), 'utf8');
  expect(stdin).toContain('[Context: sender=member1, userid=member1, chat=g1 (group)]');
  expect(stdin).toContain('群里问个问题');
  expect(readdirSync(join(ws, '.bot', 'sessions')).length).toBe(1); // 群会话档恰一份
  srv.pushTextMessage('rg2', { msgid: 'gm2', userId: 'member1', chatType: 'group', chatid: 'gX', content: '@小助手 未授权群' });
  srv.pushTextMessage('rg3', { msgid: 'gm3', userId: 'member1', chatType: 'group', chatid: 'g1', content: '没@我' });
  await new Promise((r) => setTimeout(r, 600));
  expect(streamsOf(srv).filter((s) => s.finish).length).toBe(1); // 无新增应答
  await gateway.stop(); await srv.stop();
});

test('AC3 补：群会话档 = group:<chatid>（同群第二回合 resume）', async () => {
  const { srv, gateway, stateDir, ws } = await setupCmd({ groups: ['g1'] }, { groupMentionName: '小助手' });
  srv.pushTextMessage('rg1', { msgid: 'gm1', userId: 'member1', chatType: 'group', chatid: 'g1', content: '@小助手 第一回合' });
  await waitUntil(() => streamsOf(srv).some((s) => s.finish));
  srv.pushTextMessage('rg2', { msgid: 'gm2', userId: 'member2', chatType: 'group', chatid: 'g1', content: '@小助手 第二回合' });
  await waitUntil(() => streamsOf(srv).filter((s) => s.finish).length === 2);
  const argv = argvLog(stateDir);
  expect(argv[1]!.resumeId).not.toBeNull(); // 同群第二回合 resume（群会话键路由正确）
  expect(readdirSync(join(ws, '.bot', 'sessions')).length).toBe(1); // 单一群会话档
  await gateway.stop(); await srv.stop();
});

test('AC4：enter_chat 5s 内欢迎（allowed→命令清单；unknown→拒绝）', async () => {
  const { srv, gateway } = await setupCmd({ approved: ['u1'] });
  const t0 = Date.now();
  srv.pushEnterChat('rec1', { msgid: 'e1', userId: 'u1' });
  srv.pushEnterChat('rec2', { msgid: 'e2', userId: 'stranger' });
  await waitUntil(() => srv.welcomeFrames.length === 2);
  expect(Date.now() - t0).toBeLessThan(5_000);
  const w1 = (srv.welcomeFrames[0]!.body as { text?: { content?: string } }).text!.content!;
  const w2 = (srv.welcomeFrames[1]!.body as { text?: { content?: string } }).text!.content!;
  expect(w1).toContain('/help');
  expect(w2).toContain('未被授权');
  await gateway.stop(); await srv.stop();
});

test('AC4 补：/stop 在跑回合——中止终帧收流（clean stream close）', async () => {
  const { srv, gateway } = await setupCmd({ approved: ['u1'] }, {}, 'no-output');
  srv.pushTextMessage('rq1', { msgid: 'm1', userId: 'u1', content: '长任务' });
  await new Promise((r) => setTimeout(r, 500)); // 回合在跑（no-output 挂住）
  srv.pushTextMessage('rq2', { msgid: 'm2', userId: 'u1', content: '/stop' });
  await waitUntil(() => streamsOf(srv).some((s) => s.finish));
  const last = streamsOf(srv).at(-1)!;
  expect(last.finish).toBe(true);
  expect(last.content).toContain('已停止当前回合');
  await gateway.stop(); await srv.stop();
});

test('R1-F5 /new 在跑编排：中止终帧 + 重置回执 + 排队消息不再起跑 + 旧档闭锁 + 下回合 fresh', async () => {
  const { srv, gateway, stateDir, ws } = await setupCmd({ approved: ['u1'] }, {}, 'no-output');
  srv.pushTextMessage('rq1', { msgid: 'm1', userId: 'u1', content: '长任务' });        // 在跑
  await new Promise((r) => setTimeout(r, 500));
  srv.pushTextMessage('rq2', { msgid: 'm2', userId: 'u1', content: '排队消息' });       // 排队（busy 挡住）
  await new Promise((r) => setTimeout(r, 300));
  srv.pushTextMessage('rq3', { msgid: 'm3', userId: 'u1', content: '/new' });           // 中止 + 清队列 + 闭档
  // 双条件各自独立等待（R2-F4——重置回执与中止终帧到达次序不定）
  await waitUntil(() => streamsOf(srv).some((s) => s.finish && s.content.includes('已重置会话')));
  await waitUntil(() => streamsOf(srv).some((s) => s.finish && s.content.includes('已停止当前回合')));
  await new Promise((r) => setTimeout(r, 800));
  expect(argvLog(stateDir).length).toBe(1);          // 排队消息从未 spawn（argv 恒 1）
  expect(activeSessions(ws)).toBe(0);                // 旧档已闭（close() 改写 status='closed'，文件保留）
  // R2-F3：no-output 永不产出——fresh 回合断言前把 fake 切到 happy（helper 每次 spawn 读当前 env）
  process.env.FAKE_CLAUDE_SCENARIO = 'happy';
  srv.pushTextMessage('rq4', { msgid: 'm4', userId: 'u1', content: '新开始' });         // fresh 回合
  await waitUntil(() => streamsOf(srv).some((s) => s.finish && s.content.includes('假回复')));
  expect(argvLog(stateDir).at(-1)!.resumeId).toBeNull();  // /new 后 fresh（无 resume）
  await gateway.stop(); await srv.stop();
});
