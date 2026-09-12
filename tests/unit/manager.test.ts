import { test, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentManager, TURN_TIMEOUT_ERROR, type AgentEvent } from '../../src/agent/manager';
import { SessionStore } from '../../src/agent/session-store';
import { BotLogger } from '../../src/logger';

const HELPER = join(import.meta.dir, '..', 'helpers', 'fake-claude.mjs');
const FAKE = () => ({ command: process.execPath, argsPrefix: [HELPER] });

function makeManager(scenario: string, opts: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-mgr-'));
  const stateDir = join(dir, 'state');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(dir, 'logs'), { recursive: true });
  const logger = new BotLogger({ level: 'debug', logDir: join(dir, 'logs'), console: false });
  const sessions = new SessionStore(join(dir, 'sessions'));
  process.env.FAKE_CLAUDE_STATE_DIR = stateDir;
  process.env.FAKE_CLAUDE_SCENARIO = scenario;
  const manager = new AgentManager({
    workspacePath: dir, sessions, logger,
    options: { claudeCommand: FAKE(), turnTimeoutMs: 5_000, idleTtlMs: 60_000, ...opts },
  });
  return { dir, stateDir, manager, sessions };
}

const flush = (ms = 400) => new Promise((r) => setTimeout(r, ms));
const argvLog = (stateDir: string) =>
  readFileSync(join(stateDir, 'argv.jsonl'), 'utf8').trim().split('\n')
    .map((l) => JSON.parse(l) as { argv: string[]; resumeId: string | null; cwd: string; hasClaudecode: boolean; pid: number; ts: number });
const stdinLog = (stateDir: string) =>
  existsSync(join(stateDir, 'stdin.jsonl'))
    ? readFileSync(join(stateDir, 'stdin.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { type: string; message?: { content: string }; response?: unknown })
    : [];

test('happy：spawn 参数完整、cwd=workspace、env 无 CLAUDECODE、stdin 收到 user 消息、事件序 text_delta→turn_complete', async () => {
  const { dir, stateDir, manager } = makeManager('happy');
  const events: AgentEvent[] = [];
  const verdict = manager.submit('single:u1', 'single', 'u1', '[Context: sender=u1…]\n\n你好', (ev) => { events.push(ev); });
  expect(verdict).toBe('started');
  await flush();
  const a = argvLog(stateDir)[0]!;
  expect(a.argv).toContain('--print');
  expect(a.argv).toContain('--output-format'); expect(a.argv).toContain('stream-json');
  expect(a.argv).toContain('--input-format'); expect(a.argv).toContain('stream-json');
  expect(a.argv).toContain('--permission-prompt-tool'); expect(a.argv).toContain('stdio');
  expect(a.argv).toContain('--permission-mode'); expect(a.argv).toContain('bypassPermissions');
  expect(a.argv.join(' ')).toContain('--model glm-5.3-flash');
  expect(a.argv.join(' ')).toContain('--append-system-prompt');
  expect(a.resumeId).toBeNull();
  expect(a.cwd).toBe(dir);
  expect(a.hasClaudecode).toBe(false);
  const stdin1 = stdinLog(stateDir)[0]!;
  expect(stdin1.type).toBe('user');
  expect(stdin1.message!.content).toContain('你好');
  expect(events.some((e) => e.type === 'text_delta' && e.text.includes('假回复'))).toBe(true);
  expect(events.at(-1)!.type).toBe('turn_complete');
  await manager.closeAll();
});

test('resume：第二回合带 --resume <sid>（session_id 从流事件捕获持久）', async () => {
  const { stateDir, manager } = makeManager('happy');
  manager.submit('single:u1', 'single', 'u1', 'm1', () => {});
  await flush();
  manager.submit('single:u1', 'single', 'u1', 'm2', () => {});
  await flush();
  const argvs = argvLog(stateDir);
  expect(argvs[1]!.argv).toContain('--resume');
  const sessions = readFileSync(join(stateDir, 'sessions.jsonl'), 'utf8').trim().split('\n');
  expect(argvs[1]!.argv[argvs[1]!.argv.indexOf('--resume') + 1]).toBe(sessions[0]);
  await manager.closeAll();
});

test('队列：busy 时后续消息入队，回合结束 drain 为一个批量回合（2 条排队 ⇒ 【消息 N】框架）', async () => {
  const { stateDir, manager } = makeManager('happy');
  manager.submit('single:u1', 'single', 'u1', '第一条', () => {});   // 立即起跑
  expect(manager.submit('single:u1', 'single', 'u1', '第二条', () => {})).toBe('queued');
  expect(manager.submit('single:u1', 'single', 'u1', '第三条', () => {})).toBe('queued');
  await flush(900);
  const stdins = stdinLog(stateDir);
  expect(stdins.length).toBe(2); // 回合1 + 批量回合（2、3 合一）
  expect(stdins[1]!.message!.content).toContain('2 条排队消息');
  expect(stdins[1]!.message!.content).toContain('【消息 1】');
  expect(stdins[1]!.message!.content).toContain('【消息 2】');
  await manager.closeAll();
});

test('ask：control_request 注册 pending；数字作答写回 control_response（answers 携带 label）；作答后回合继续至 complete', async () => {
  const { stateDir, manager } = makeManager('ask');
  const events: AgentEvent[] = [];
  manager.submit('single:u1', 'single', 'u1', '开始', (ev) => { events.push(ev); });
  await flush();
  expect(manager.hasPendingAsk('single:u1')).toBe(true);
  expect(events.some((e) => e.type === 'ask')).toBe(true);
  expect(manager.answerPendingAsk('single:u1', '2')).toBe('answered');
  await flush();
  const responses = stdinLog(stateDir).filter((l) => l.type === 'control_response') as Array<{ response: { request_id: string; response: { behavior: string; updatedInput: { answers: Record<string, string> } } } }>;
  expect(responses.length).toBe(1);
  expect(responses[0]!.response.request_id).toBe('cr-1');
  expect(responses[0]!.response.response.behavior).toBe('allow');
  expect(responses[0]!.response.response.updatedInput.answers).toEqual({ '选哪个方案？': '乙' });
  expect(events.at(-1)!.type).toBe('turn_complete');
  expect(manager.hasPendingAsk('single:u1')).toBe(false);
  await manager.closeAll();
});

test('ask：多选 1,3 跨题分配；非数字 ⇒ 首题自由文本；越界 ⇒ invalid_numeric 且 pending 保持', async () => {
  const { stateDir, manager } = makeManager('ask-multi');
  manager.submit('single:u1', 'single', 'u1', '开始', () => {});
  await flush();
  expect(manager.answerPendingAsk('single:u1', '1,3')).toBe('answered');
  await flush();
  const responses = stdinLog(stateDir).filter((l) => l.type === 'control_response') as Array<{ response: { response: { updatedInput: { answers: Record<string, string> } } } }>;
  expect(responses[0]!.response.response.updatedInput.answers).toEqual({ '用哪个库？': 'bun', '要不要日志？': '要' });
  await manager.closeAll();

  const m2 = makeManager('ask-multi');
  m2.manager.submit('single:u2', 'single', 'u2', '开始', () => {});
  await flush();
  expect(m2.manager.answerPendingAsk('single:u2', '直接用 bun')).toBe('answered');
  await flush(); // fake 读取并落记 control_response 需要一个节拍
  const free = stdinLog(m2.stateDir).filter((l) => l.type === 'control_response') as Array<{ response: { response: { updatedInput: { answers: Record<string, string> } } } }>;
  expect(free[0]!.response.response.updatedInput.answers).toEqual({ '用哪个库？': '直接用 bun' });
  await m2.manager.closeAll();

  const m3 = makeManager('ask');
  m3.manager.submit('single:u3', 'single', 'u3', '开始', () => {});
  await flush();
  expect(m3.manager.answerPendingAsk('single:u3', '9')).toBe('invalid_numeric');
  expect(m3.manager.hasPendingAsk('single:u3')).toBe(true);
  await m3.manager.closeAll();
});

test('超时护栏（AC5）：no-output 回合在压缩 turnTimeoutMs 后被杀并报 turn_failed(timeout)；并发多回合各自计时互不清除', async () => {
  const { manager } = makeManager('no-output', { turnTimeoutMs: 300, maxConcurrentTurns: 4 });
  const ev1: AgentEvent[] = [];
  const ev2: AgentEvent[] = [];
  manager.submit('single:u1', 'single', 'u1', '慢回合1', (ev) => { ev1.push(ev); });
  manager.submit('single:u2', 'single', 'u2', '慢回合2', (ev) => { ev2.push(ev); }); // 并发第二回合
  await flush(1_500);
  for (const evs of [ev1, ev2]) {
    const fail = evs.find((e) => e.type === 'turn_failed');
    expect(fail).toBeDefined();
    expect((fail as { error: string }).error).toContain(TURN_TIMEOUT_ERROR);
  }
  await manager.closeAll();
});

test('信号无视的子进程：收割梯子升级 SIGKILL，turn_failed 仍按期发出', async () => {
  const { manager } = makeManager('ignore-signals', { turnTimeoutMs: 300, reapEofMs: 200, reapTermMs: 200 });
  const events: AgentEvent[] = [];
  manager.submit('single:u1', 'single', 'u1', '顽固回合', (ev) => { events.push(ev); });
  await flush(4_000); // 300ms 超时 + 200ms EOF 宽限 + 200ms TERM 宽限 + KILL 沉降
  const fail = events.find((e) => e.type === 'turn_failed');
  expect(fail).toBeDefined();
  expect((fail as { error: string }).error).toContain(TURN_TIMEOUT_ERROR);
  await manager.closeAll();
});

test('晚输出竞态：deadline 先于输出到达 ⇒ 杀 + turn_failed(timeout)，失败后无迟到流活动', async () => {
  process.env.FAKE_CLAUDE_DELAY_MS = '1500';
  const { manager } = makeManager('slow-output', { turnTimeoutMs: 300 });
  const events: AgentEvent[] = [];
  manager.submit('single:u1', 'single', 'u1', '慢输出', (ev) => { events.push(ev); });
  await flush(2_500); // deadline(300ms) 杀进程后，fake 的迟到输出不应再产生事件
  const fail = events.find((e) => e.type === 'turn_failed');
  expect(fail).toBeDefined();
  expect((fail as { error: string }).error).toContain(TURN_TIMEOUT_ERROR);
  const after = events.slice(events.indexOf(fail!));
  expect(after.every((e) => e.type !== 'text_delta' && e.type !== 'turn_complete')).toBe(true);
  await manager.closeAll();
  delete process.env.FAKE_CLAUDE_DELAY_MS;
});

test('spawn 失败（ENOENT）：turn_failed 带可识别错误', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-mgr-'));
  mkdirSync(join(dir, 'logs'), { recursive: true });
  const logger = new BotLogger({ level: 'debug', logDir: join(dir, 'logs'), console: false });
  const manager = new AgentManager({
    workspacePath: dir, sessions: new SessionStore(join(dir, 'sessions')), logger,
    options: { claudeCommand: { command: '/nonexistent/claude-binary', argsPrefix: [] } },
  });
  const events: AgentEvent[] = [];
  manager.submit('single:u1', 'single', 'u1', 'x', (ev) => { events.push(ev); });
  await flush(600);
  const fail = events.find((e) => e.type === 'turn_failed') as { error: string } | undefined;
  expect(fail).toBeDefined();
  expect(fail!.error).toMatch(/spawn|ENOENT/i);
  await manager.closeAll();
});

test('resume 失败：No conversation found ⇒ 恰好一次 fresh 重试（重试 argv 无 --resume，回合最终 complete）', async () => {
  const { stateDir, manager } = makeManager('resume-not-found');
  const events: AgentEvent[] = [];
  manager.submit('single:u1', 'single', 'u1', '第一回合', () => {}); // fake: 无 resumeId ⇒ 正常
  await flush();
  manager.submit('single:u1', 'single', 'u1', '第二回合', (ev) => { events.push(ev); }); // fake: --resume 在场 ⇒ 报错 → 重试
  await flush(900);
  const argvs = argvLog(stateDir);
  expect(argvs.length).toBe(3); // turn1 + turn2(resume) + turn2-retry(fresh)
  expect(argvs[2]!.resumeId).toBeNull();
  expect(events.at(-1)!.type).toBe('turn_complete');
  await manager.closeAll();
});

test('崩溃与垃圾输出：crash ⇒ turn_failed(stderr 摘要)；garbage(EOF 无终态且 exit 0) 也 ⇒ turn_failed（不留孤儿流）', async () => {
  const m1 = makeManager('crash');
  const ev1: AgentEvent[] = [];
  m1.manager.submit('single:c1', 'single', 'c1', 'x', (ev) => { ev1.push(ev); });
  await flush();
  expect(ev1.at(-1)!.type).toBe('turn_failed');
  await m1.manager.closeAll();

  const m2 = makeManager('garbage');
  const ev2: AgentEvent[] = [];
  m2.manager.submit('single:c2', 'single', 'c2', 'x', (ev) => { ev2.push(ev); });
  await flush();
  expect(ev2.at(-1)!.type).toBe('turn_failed');
  await m2.manager.closeAll();
});

test('并发帽：全局 maxConcurrentTurns=1 时第二个 chat 的消息排队，第一个回合结束后才获准运行（跨 chat 提升）', async () => {
  const { stateDir, manager } = makeManager('happy', { maxConcurrentTurns: 1 });
  const evA: AgentEvent[] = [];
  manager.submit('single:a', 'single', 'a', 'x', (ev) => { evA.push(ev); });
  const v = manager.submit('single:b', 'single', 'b', 'y', () => {});
  expect(v).toBe('queued');
  await flush(900); // a 回合收尾后调度器唤醒排队中的 b（跨 chat promote）
  const stdins = stdinLog(stateDir);
  expect(stdins.length).toBe(2);
  expect(stdins[0]!.message!.content).toContain('x');
  expect(stdins[1]!.message!.content).toContain('y');
  expect(evA.at(-1)!.type).toBe('turn_complete');
  await manager.closeAll();
});

test('每用户并发帽：同用户第 4 个会话的消息排队（前 3 在跑），前一回合收尾后被提升运行', async () => {
  const { stateDir, manager } = makeManager('no-output', { turnTimeoutMs: 700, maxConcurrentTurns: 8 });
  const argvCount = () => argvLog(stateDir).length; // no-output 场景不读 stdin——以 spawn 计数（argv.jsonl 行数）为证
  manager.submit('single:u1', 'single', 'u1', 'a', () => {});
  manager.submit('group:g1', 'group', 'u1', 'b', () => {});
  manager.submit('group:g2', 'group', 'u1', 'c', () => {}); // 3 个 in-flight = 平台帽
  const v4 = manager.submit('group:g3', 'group', 'u1', 'd', () => {}); // 第 4 ⇒ 排队
  expect(v4).toBe('queued');
  await flush(400);
  expect(argvCount()).toBe(3); // d 未起跑
  await flush(1_600); // 前三回合超时收尾 ⇒ d 被提升
  expect(argvCount()).toBe(4);
  await manager.closeAll();
});

test('群聊混合发送者批量回合：并发帽按排队发送者全体计（perUserInFlight=1，批量运行期两发送者都被占满）', async () => {
  process.env.FAKE_CLAUDE_DELAY_MS = '1000'; // 慢输出——探测窗口内回合保持 in-flight
  const { manager } = makeManager('slow-output', { perUserInFlight: 1, maxConcurrentTurns: 8, turnTimeoutMs: 8_000 });
  manager.submit('group:g1', 'group', 'u1', '甲的消息', () => {});                    // u1 占 group:g1（~1.05s）
  expect(manager.submit('group:g1', 'group', 'u2', '乙的排队消息', () => {})).toBe('queued'); // busy ⇒ 排队
  expect(manager.submit('group:g1', 'group', 'u3', '丙的排队消息', () => {})).toBe('queued');
  await flush(1_300); // 回合1 收尾；批量回合（u2+u3 两条排队消息，initiators=[u2,u3]）起跑，~1s 运行窗口
  expect(manager.submit('single:u2', 'single', 'u2', 'u2 再来', () => {})).toBe('queued'); // u2 被运行中的批量回合占用（R2-F8）
  expect(manager.submit('single:u3', 'single', 'u3', 'u3 再来', () => {})).toBe('queued'); // u3 同样被占用
  expect(manager.submit('single:u1', 'single', 'u1', 'u1 已释放', () => {})).toBe('started'); // 回合1 已完结，u1 不被批量回合牵连
  expect(manager.submit('single:u4', 'single', 'u4', 'u4 不受影响', () => {})).toBe('started');
  await manager.closeAll();
  delete process.env.FAKE_CLAUDE_DELAY_MS;
});

test('过期 ask：收割完成后才放行后续回合（新 spawn 不与旧进程重叠）', async () => {
  const { stateDir, manager } = makeManager('ask', { idleTtlMs: 300, reapEofMs: 250, reapTermMs: 250 });
  const events: AgentEvent[] = [];
  manager.submit('single:u1', 'single', 'u1', '开始', (ev) => { events.push(ev); });
  await flush();
  expect(manager.hasPendingAsk('single:u1')).toBe(true);
  await new Promise((r) => setTimeout(r, 400)); // 会话 TTL 过期
  expect(manager.expireStaleAsk('single:u1')).toBe(true);
  const v = manager.submit('single:u1', 'single', 'u1', '新问题', (ev) => { events.push(ev); });
  expect(v).toBe('queued'); // 旧进程收割期间排队，不并行 spawn
  await flush(1_500);
  const argvs = argvLog(stateDir);
  expect(argvs.length).toBe(2); // 旧回合 + 收割完成后的新回合
  const exits = readFileSync(join(stateDir, 'exit.jsonl'), 'utf8').trim().split('\n')
    .map((l) => JSON.parse(l) as { pid: number; ts: number });
  const oldExit = exits.find((e) => e.pid === argvs[0]!.pid);
  expect(oldExit).toBeDefined();
  expect(oldExit!.ts).toBeLessThanOrEqual(argvs[1]!.ts); // 旧进程退出先于新 spawn（R2-F3 的可证形态）
  expect(events.filter((e) => e.type === 'ask').length).toBe(2); // 新回合正常起步（ask 场景再问一次）
  await manager.closeAll();
});
