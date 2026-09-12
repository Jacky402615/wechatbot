import { test, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentManager, TURN_TIMEOUT_ERROR, TURN_ABORTED_ERROR, type AgentEvent } from '../../src/agent/manager';
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
/** pr-review P5：子进程终止证据——kill(pid,0) 抛 ESRCH 即已死（SIGKILL 路径 exit.jsonl 不可靠） */
async function assertPidsDead(stateDir: string, pids: number[], ms = 3_000): Promise<void> {
  const t0 = Date.now();
  let alive = pids;
  while (alive.length > 0 && Date.now() - t0 < ms) {
    alive = alive.filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
    if (alive.length > 0) await new Promise((r) => setTimeout(r, 100));
  }
  expect(alive).toEqual([]);
}

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
  expect(await manager.answerPendingAsk('single:u1', '2')).toBe('answered');
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
  expect(await manager.answerPendingAsk('single:u1', '1,3')).toBe('answered');
  await flush();
  const responses = stdinLog(stateDir).filter((l) => l.type === 'control_response') as Array<{ response: { response: { updatedInput: { answers: Record<string, string> } } } }>;
  expect(responses[0]!.response.response.updatedInput.answers).toEqual({ '用哪个库？': 'bun', '要不要日志？': '要' });
  await manager.closeAll();

  const m2 = makeManager('ask-multi');
  m2.manager.submit('single:u2', 'single', 'u2', '开始', () => {});
  await flush();
  expect(await m2.manager.answerPendingAsk('single:u2', '直接用 bun')).toBe('answered');
  await flush(); // fake 读取并落记 control_response 需要一个节拍
  const free = stdinLog(m2.stateDir).filter((l) => l.type === 'control_response') as Array<{ response: { response: { updatedInput: { answers: Record<string, string> } } } }>;
  expect(free[0]!.response.response.updatedInput.answers).toEqual({ '用哪个库？': '直接用 bun' });
  await m2.manager.closeAll();

  const m3 = makeManager('ask');
  m3.manager.submit('single:u3', 'single', 'u3', '开始', () => {});
  await flush();
  expect(await m3.manager.answerPendingAsk('single:u3', '9')).toBe('invalid_numeric');
  expect(m3.manager.hasPendingAsk('single:u3')).toBe(true);
  await m3.manager.closeAll();
});

test('超时护栏（AC5）：no-output 回合在压缩 turnTimeoutMs 后被杀并报 turn_failed(timeout)；并发多回合各自计时互不清除；子进程确已终止', async () => {
  const { stateDir, manager } = makeManager('no-output', { turnTimeoutMs: 300, maxConcurrentTurns: 4 });
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
  await assertPidsDead(stateDir, argvLog(stateDir).map((a) => a.pid)); // pr-review P5：终止证据
  await manager.closeAll();
});

test('信号无视的子进程：收割梯子升级 SIGKILL，turn_failed 仍按期发出；子进程确已终止（SIGKILL 路径）', async () => {
  const { stateDir, manager } = makeManager('ignore-signals', { turnTimeoutMs: 300, reapEofMs: 200, reapTermMs: 200 });
  const events: AgentEvent[] = [];
  manager.submit('single:u1', 'single', 'u1', '顽固回合', (ev) => { events.push(ev); });
  await flush(4_000); // 300ms 超时 + 200ms EOF 宽限 + 200ms TERM 宽限 + KILL 沉降
  const fail = events.find((e) => e.type === 'turn_failed');
  expect(fail).toBeDefined();
  expect((fail as { error: string }).error).toContain(TURN_TIMEOUT_ERROR);
  await assertPidsDead(stateDir, argvLog(stateDir).map((a) => a.pid)); // pr-review P5
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
  expect(fail!.error).toMatch(/spawn|ENOENT|stdin write failed/i); // pr-review P2 后：管道死先于 spawn 错误回调也成立
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

test('终态回调抛错不产生重复终态：onEvent(turn_complete) reject ⇒ 恰一个终态事件、无补发 turn_failed（pr-review P4）', async () => {
  const { manager } = makeManager('happy');
  const events: AgentEvent[] = [];
  let firstTerminalSeen = false;
  manager.submit('single:u1', 'single', 'u1', 'x', (ev) => {
    events.push(ev);
    if (ev.type === 'turn_complete' && !firstTerminalSeen) {
      firstTerminalSeen = true;
      throw new Error('consumer broke mid-terminal'); // 终态后的消费方崩溃
    }
  });
  await flush(800);
  expect(events.filter((e) => e.type === 'turn_complete').length).toBe(1); // 恰一个终态
  expect(events.filter((e) => e.type === 'turn_failed').length).toBe(0);   // 无补发失败（不重复终态）
  await manager.closeAll();
});

test('帽满作答者被拒收：answerer-busy、pending 保持、发起人仍可作答（pr-review P1）', async () => {
  const { manager } = makeManager('ask', { perUserInFlight: 3, maxConcurrentTurns: 8, turnTimeoutMs: 30_000, idleTtlMs: 60_000 });
  // u2 占满自己的 3 个 in-flight（ask 等待长活）
  manager.submit('single:a', 'single', 'u2', 'x1', () => {});
  manager.submit('single:b', 'single', 'u2', 'x2', () => {});
  manager.submit('single:c', 'single', 'u2', 'x3', () => {});
  manager.submit('group:g1', 'group', 'u1', '开始', () => {});
  await flush(200);
  expect(manager.hasPendingAsk('group:g1')).toBe(true);
  // u2（帽满、非发起人）作答 ⇒ 拒收；ask 保持 pending
  expect(await manager.answerPendingAsk('group:g1', '1', 'u2')).toBe('answerer-busy');
  expect(manager.hasPendingAsk('group:g1')).toBe(true);
  // 发起人 u1（in-flight 1 < 3）不受影响
  expect(await manager.answerPendingAsk('group:g1', '1', 'u1')).toBe('answered');
  await manager.closeAll();
});

test('过期 ask（TTL 计时器路径）：ask_expired 恰一次、无通用 turn_failed（code-review C2/C3）', async () => {
  const { manager } = makeManager('ask', { idleTtlMs: 300, reapEofMs: 250, reapTermMs: 250 });
  const events: AgentEvent[] = [];
  manager.submit('single:u1', 'single', 'u1', '开始', (ev) => { events.push(ev); });
  await flush(150); // ask 落定（须早于 300ms 的 TTL 计时器）
  expect(manager.hasPendingAsk('single:u1')).toBe(true);
  await flush(1_800); // ask TTL(300ms) 计时器到点杀进程 + 收割 + runTurn EOF 路径走完
  expect(manager.hasPendingAsk('single:u1')).toBe(false);   // 槽位与 pending 均已清
  expect(events.filter((e) => e.type === 'ask_expired').length).toBe(1); // 恰一次
  expect(events.filter((e) => e.type === 'turn_failed').length).toBe(0); // 无通用失败
  await manager.closeAll();
});

test('弃置 ask（无人作答）：TTL 计时器到点自动释放全局槽位，排队回合获准运行（code-review C3）', async () => {
  const { stateDir, manager } = makeManager('ask', { idleTtlMs: 400, maxConcurrentTurns: 1, turnTimeoutMs: 8_000 });
  const evU2: AgentEvent[] = [];
  manager.submit('single:u1', 'single', 'u1', '开始', () => {});
  await flush();
  expect(manager.hasPendingAsk('single:u1')).toBe(true);
  // 全局帽=1 已被 ask 等待回合占用——另一 chat 排队
  expect(manager.submit('single:u2', 'single', 'u2', '别的会话', (ev) => { evU2.push(ev); })).toBe('queued');
  await flush(2_000); // ask TTL(400ms) 到点杀进程 + 收割 + 调度提升 + u2 回合跑起（再 ask）
  const argvs = argvLog(stateDir);
  expect(argvs.length).toBe(2); // u2 的回合确实运行了——槽位被自动释放过
  expect(evU2.some((e) => e.type === 'ask')).toBe(true); // u2 回合正常起步（ask 场景再问）
  await manager.closeAll();
});

test('过期 ask 后的新消息：收割完成后才放行（新 spawn 不与旧进程重叠）', async () => {
  const { stateDir, manager } = makeManager('ask', { idleTtlMs: 300, reapEofMs: 250, reapTermMs: 250 });
  const events: AgentEvent[] = [];
  manager.submit('single:u1', 'single', 'u1', '开始', (ev) => { events.push(ev); });
  await flush(150); // ask 落定（须早于 300ms 的 TTL 计时器）
  expect(manager.hasPendingAsk('single:u1')).toBe(true);
  await flush(900); // ask TTL(300ms) 已击杀旧进程（收割中/已完成）
  const v = manager.submit('single:u1', 'single', 'u1', '新问题', (ev) => { events.push(ev); });
  expect(['queued', 'started']).toContain(v); // 收割窗口内排队；收割完成则起步——绝不并行 spawn
  await flush(1_800);
  const argvs = argvLog(stateDir);
  expect(argvs.length).toBe(2); // 旧回合 + 新回合
  const exits = readFileSync(join(stateDir, 'exit.jsonl'), 'utf8').trim().split('\n')
    .map((l) => JSON.parse(l) as { pid: number; ts: number });
  const oldExit = exits.find((e) => e.pid === argvs[0]!.pid);
  expect(oldExit).toBeDefined();
  expect(oldExit!.ts).toBeLessThanOrEqual(argvs[1]!.ts); // 旧进程退出先于新 spawn（R2-F3 的可证形态）
  expect(events.filter((e) => e.type === 'ask').length).toBe(2); // 新回合正常起步（ask 场景再问一次）
  // R3-2：旧回合终态（ask_expired）先于新回合任何事件——替补不抢跑
  const expiredIdx = events.findIndex((e) => e.type === 'ask_expired');
  const secondAskIdx = events.findIndex((e, i) => i > events.indexOf(events.find((e2) => e2.type === 'ask')!) && e.type === 'ask');
  expect(expiredIdx).toBeGreaterThan(-1);
  expect(secondAskIdx).toBeGreaterThan(expiredIdx);
  await manager.closeAll();
});

test('群作答者计入并发帽：帽下作答 ⇒ 归因生效，其第 4 回合排队（R2-C2/R3-F2 正路径）', async () => {
  // 单 manager：u2 的两个 ask 等待回合（无人作答即长活）+ u1 的群 ask——全部同场景
  const { manager } = makeManager('ask', { perUserInFlight: 3, maxConcurrentTurns: 8, turnTimeoutMs: 30_000, idleTtlMs: 60_000 });
  manager.submit('single:a', 'single', 'u2', 'x1', () => {});  // u2 in-flight 1（ask 等待长活）
  manager.submit('single:b', 'single', 'u2', 'x2', () => {});  // u2 in-flight 2
  manager.submit('group:g1', 'group', 'u1', '开始', () => {});
  await flush(200);
  expect(manager.hasPendingAsk('single:a')).toBe(true);
  expect(manager.hasPendingAsk('single:b')).toBe(true);
  expect(manager.hasPendingAsk('group:g1')).toBe(true);
  // u2（in-flight 2 < 帽 3）作答群 ask：受理且归因——u2 计数升至 3
  expect(await manager.answerPendingAsk('group:g1', '1', 'u2')).toBe('answered');
  // 归因后 u2 达帽：第 4 回合排队（证明作答者确实计入平台帽）
  expect(manager.submit('single:d', 'single', 'u2', 'x4', () => {})).toBe('queued');
  await manager.closeAll();
});

test('并发作答单认领：同一 tick 两个作答 ⇒ 恰一个 control_response、另一个 none（pr-review R3-1）', async () => {
  const { stateDir, manager } = makeManager('ask', { turnTimeoutMs: 30_000 });
  manager.submit('single:u1', 'single', 'u1', '开始', () => {});
  await flush(150);
  expect(manager.hasPendingAsk('single:u1')).toBe(true);
  const [r1, r2] = await Promise.all([
    manager.answerPendingAsk('single:u1', '1', 'u1'),
    manager.answerPendingAsk('single:u1', '2', 'u9'), // 双击/抢答：同一 pending
  ]);
  expect([r1, r2].sort()).toEqual(['answered', 'none']); // 同步认领——恰一个成功
  await flush(600);
  const responses = stdinLog(stateDir).filter((l) => l.type === 'control_response');
  expect(responses.length).toBe(1); // 恰一份 control_response
  await manager.closeAll();
});

test('W3 abortChat：在跑回合被杀，EOF 路径发 turn_failed(TURN_ABORTED_ERROR)，槽位释放、进程死；双击第二击 = stopping', async () => {
  const { stateDir, manager } = makeManager('no-output'); // 永不产出——等被杀
  const events: AgentEvent[] = [];
  manager.submit('single:u1', 'single', 'u1', 'm1', (ev) => { events.push(ev); });
  await flush(200); // 等子进程起跑
  const pid = argvLog(stateDir).at(-1)!.pid;
  const r = manager.abortChat('single:u1');
  expect(r.status).toBe('stopped');
  expect(manager.abortChat('single:u1').status).toBe('stopping'); // 双击——中止中，非 idle
  await flush(800);
  expect(events.some((e) => e.type === 'turn_failed' && e.error === TURN_ABORTED_ERROR)).toBe(true);
  expect(manager.inFlightCount()).toBe(0);
  expect(manager.abortChat('single:u1').status).toBe('idle'); // 终局后才是 idle
  await assertPidsDead(stateDir, [pid]);
  await manager.closeAll();
});

test('W3 abortChat：排队消息一并清空（dropped 计数）', async () => {
  const { manager } = makeManager('no-output');
  manager.submit('single:u1', 'single', 'u1', 'm1', () => {}); // 占住 chat
  manager.submit('single:u1', 'single', 'u1', 'm2', () => {}); // 排队
  const r = manager.abortChat('single:u1');
  expect(r.status).toBe('stopped');
  expect(r.dropped).toBe(1);
  await flush(800);
  await manager.closeAll();
});

test('W3 abortChat：pending ask 中的回合一并中止（不发 ask_expired、不发通用失败）', async () => {
  const { manager } = makeManager('ask');
  const events: AgentEvent[] = [];
  manager.submit('single:u1', 'single', 'u1', 'm1', (ev) => { events.push(ev); });
  await new Promise((r) => setTimeout(r, 500)); // 等 ask 到达
  expect(manager.hasPendingAsk('single:u1')).toBe(true);
  const r = manager.abortChat('single:u1');
  expect(r.status).toBe('stopped');
  await flush(800);
  expect(manager.hasPendingAsk('single:u1')).toBe(false);
  expect(events.some((e) => e.type === 'turn_failed' && e.error === TURN_ABORTED_ERROR)).toBe(true);
  expect(events.some((e) => e.type === 'ask_expired')).toBe(false);
  await manager.closeAll();
});

test('W3 resetSession / activeSessionCount / listActive：闭档后活跃数归零', async () => {
  const { manager, sessions } = makeManager('happy');
  expect(manager.activeSessionCount()).toBe(0);
  manager.submit('single:u1', 'single', 'u1', 'm1', () => {});
  await flush();
  expect(manager.activeSessionCount()).toBe(1);
  expect(sessions.listActive()).toBe(1);
  manager.resetSession('single:u1');
  expect(manager.activeSessionCount()).toBe(0);
  await manager.closeAll();
});
