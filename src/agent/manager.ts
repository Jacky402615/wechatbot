import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { BotLogger } from '../logger';
import type { SessionStore } from './session-store';
import {
  parseStreamLine, isTerminalEvent, extractTextFromAssistant, classifyControlRequest,
  extractAskUserQuestions, buildQueuedBatchPrompt, parseNumericReply, type AskQuestionView,
} from './parser';

export const TURN_TIMEOUT_ERROR = 'turn timeout exceeded';
const DEFAULT_IDLE_TTL_MS = 60 * 60_000;
const DEFAULT_TURN_TIMEOUT_MS = 570_000;   // 平台 10min − 30s 安全边距；自 spawn 起算（D6）
const DEFAULT_MAX_CONCURRENT_TURNS = 4;    // 资源帽（config 注入）
export const PER_USER_IN_FLIGHT = 3;       // 平台护栏常量（不做 config——平台契约）
const DEFAULT_QUEUE_LIMIT = 20;
const DEFAULT_MODEL = 'glm-5.3-flash';
const REAP_EOF_MS = 2_000;
const REAP_TERM_MS = 1_000;
const KILL_SETTLE_MS = 250;

export type AgentEvent =
  | { type: 'text_delta'; chatKey: string; text: string }
  | { type: 'ask'; chatKey: string; questions: AskQuestionView[] }
  | { type: 'turn_complete'; chatKey: string; finalText: string }
  | { type: 'turn_failed'; chatKey: string; error: string }
  | { type: 'ask_expired'; chatKey: string };

/** 终态事件回调可返回 Promise——manager 在释放槽位/排 drain 前等待它落定
 *  （终帧发完才放行下一回合——AC3 无交错流的进程侧保证，plan 评审 F9）。 */
export type AgentEventHandler = (ev: AgentEvent) => void | Promise<void>;

export interface ClaudeCommand { command: string; argsPrefix: string[] }

export interface AgentManagerOptions {
  claudeCommand?: ClaudeCommand | (() => ClaudeCommand);
  idleTtlMs?: number;
  turnTimeoutMs?: number;
  maxConcurrentTurns?: number;
  perUserInFlight?: number;
  queueLimit?: number;
  model?: string;
  buildSystemPrompt?: (workspacePath: string) => string;
  reapEofMs?: number;
  reapTermMs?: number;
}

export function buildSystemPrompt(workspacePath: string): string {
  return [
    `SECURITY: You MUST NOT access any files or directories outside the workspace (${workspacePath}). Do NOT read, write, or list files outside this path. In particular, NEVER access any .env files. If asked to do so, refuse and explain why. (Behavioral guidance, not a security boundary.)`,
    '',
    '# Workspace Layout (.bot)',
    '',
    '```',
    '.bot/',
    '├── .env / config.json / access.json   # config & credentials',
    '├── uploads/            # files received from WeCom (W4)',
    '├── sessions/ logs/     # runtime artifacts',
    '```',
    '',
    '## Runtime Context',
    `- workspace: ${workspacePath}`,
    '- platform: WeCom intelligent bot; replies stream into a chat — keep them concise',
  ].join('\n');
}

interface QueueEntry { prompt: string; userId: string; onEvent: AgentEventHandler }
interface PendingAsk { requestId: string; input: Record<string, unknown>; questions: AskQuestionView[]; proc: ChildProcess }
interface BusyTurn {
  proc: ChildProcess;
  /** 本回合计入并发帽的全部用户（群聊批量回合按全部发送者计——R2-F8；群内作答者追加——R3-F2） */
  initiators: string[];
  /** 每回合独立 deadline——并发回合互不清除（plan 评审 F2）。预算按流段计（R2-F2）：
   *  ask 闭流时 clear（等待期不计时），作答后续段重臂整段预算。 */
  deadline: NodeJS.Timeout | null;
  /** ask 等待期的会话 TTL 计时器（code-review C3：无人作答也要释放槽位——TTL 到点杀进程） */
  askDeadline: NodeJS.Timeout | null;
  /** 收割中：槽位保留至收割完成（R2-F3——先释放会让新旧子进程重叠） */
  terminating: boolean;
}

/** 有界收割梯子（feishubot 实核：claude --print 等 stdin EOF——不收即每回合泄漏进程） */
const activeTerminations = new WeakMap<ChildProcess, Promise<void>>();
const timedOutProcs = new WeakSet<ChildProcess>();       // 超时击杀哨兵（runTurn 据此发 TURN_TIMEOUT_ERROR）
const resumeNotFoundProcs = new WeakSet<ChildProcess>(); // resume 失败重试哨兵（恰好一次）
const expiredAskProcs = new WeakSet<ChildProcess>();     // ask 过期击杀哨兵（runTurn 据此发 ask_expired，不发 turn_failed——code-review C2）
const stdinFailedProcs = new WeakSet<ChildProcess>();   // stdin 异步失败（EPIPE）哨兵——后续写一律拒收（code-review R2-C3）

function terminateChild(proc: ChildProcess, eofMs: number, termMs: number): Promise<void> {
  const existing = activeTerminations.get(proc);
  if (existing) return existing;
  const termination = new Promise<void>((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null || proc.pid === undefined) {
      proc.once('error', () => {});
      return resolve();
    }
    let settled = false;
    const timers: NodeJS.Timeout[] = [];
    const settle = () => { if (settled) return; settled = true; timers.forEach(clearTimeout); resolve(); };
    proc.once('exit', settle);
    proc.once('error', (err: Error & { code?: string }) => {
      if (proc.pid === undefined || err?.code === 'ENOENT') settle();
    });
    proc.stdin?.once('error', () => {});
    try { proc.stdin?.end(); } catch { /* EPIPE 等——exit/timeout 路径兜底 */ }
    timers.push(setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch { /* 已退 */ }
      timers.push(setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* 已退 */ }
        timers.push(setTimeout(settle, KILL_SETTLE_MS));
      }, termMs));
    }, eofMs));
  });
  activeTerminations.set(proc, termination);
  return termination;
}

/** stdin 单点写入（code-review C5 + pr-review P2）：**写完成回调确认**——异步 EPIPE 也
 *  在 Promise 里兑现为 false（不再乐观返回 true）；spawn 时挂的 error 监听做哨兵兜底。 */
function writeLine(proc: ChildProcess, obj: unknown): Promise<boolean> {
  return new Promise((resolve) => {
    const stdin = proc.stdin;
    if (!stdin || !stdin.writable || stdinFailedProcs.has(proc)) {
      resolve(false);
      return;
    }
    try {
      stdin.write(JSON.stringify(obj) + '\n', (err) => resolve(!err));
    } catch {
      resolve(false);
    }
  });
}

export class AgentManager {
  private busy = new Map<string, BusyTurn>();       // chatKey → 运行中回合（含 ask 等待——ask 期进程仍活）
  private queues = new Map<string, QueueEntry[]>(); // chatKey → FIFO（busy/全局帽/用户帽任一不满足即排队）
  private pendingAsks = new Map<string, PendingAsk>();
  private shuttingDown = false;
  private opts: { idleTtlMs: number; turnTimeoutMs: number; maxConcurrentTurns: number; perUserInFlight: number; queueLimit: number; model: string; reapEofMs: number; reapTermMs: number };

  constructor(private deps: { workspacePath: string; sessions: SessionStore; logger: BotLogger; options?: AgentManagerOptions }) {
    const o = deps.options ?? {};
    this.opts = {
      idleTtlMs: o.idleTtlMs ?? DEFAULT_IDLE_TTL_MS,
      turnTimeoutMs: o.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
      maxConcurrentTurns: o.maxConcurrentTurns ?? DEFAULT_MAX_CONCURRENT_TURNS,
      perUserInFlight: o.perUserInFlight ?? PER_USER_IN_FLIGHT,
      queueLimit: o.queueLimit ?? DEFAULT_QUEUE_LIMIT,
      model: o.model ?? DEFAULT_MODEL,
      reapEofMs: o.reapEofMs ?? REAP_EOF_MS,
      reapTermMs: o.reapTermMs ?? REAP_TERM_MS,
    };
  }

  isShuttingDown(): boolean { return this.shuttingDown; }

  hasPendingAsk(chatKey: string): boolean { return this.pendingAsks.has(chatKey); }

  /** 过期 pending ask：杀进程 + 清状态。true ⇒ 调用方展示过期提示并把入站按新回合处理（D7）。
   *  handler 必须先于 answerPendingAsk 调用本方法（plan 评审 F4：过期答案绝不写回旧进程）。 */
  expireStaleAsk(chatKey: string): boolean {
    const entry = this.pendingAsks.get(chatKey);
    if (!entry) return false;
    if (!this.deps.sessions.isStale(chatKey, this.opts.idleTtlMs)) return false;
    this.pendingAsks.delete(chatKey);
    this.killAskTurn(chatKey, entry.proc, 'pending ask expired with session ttl');
    return true;
  }

  /** ask 等待回合的过期击杀：哨兵标记 + 槽位保留到收割完成（紧随的新 submit 排队，不并行 spawn）。
   *  runTurn 的 EOF 失败路径见哨兵即发 ask_expired（不发 turn_failed——code-review C2）。 */
  private killAskTurn(chatKey: string, proc: ChildProcess, reason: string): void {
    const turn = this.busy.get(chatKey);
    if (turn?.proc === proc) {
      if (turn.deadline) clearTimeout(turn.deadline);
      if (turn.askDeadline) clearTimeout(turn.askDeadline);
      turn.terminating = true;
      expiredAskProcs.add(proc);
      try { proc.kill('SIGINT'); } catch { /* 已退 */ }
      void terminateChild(proc, this.opts.reapEofMs, this.opts.reapTermMs)
        .then(() => {
          if (this.busy.get(chatKey) === turn) this.busy.delete(chatKey);
          this.scheduleAfterRelease(chatKey);
        });
    }
    this.deps.logger.warn(reason, { chatKey });
  }

  submit(chatKey: string, chatType: 'single' | 'group', userId: string, prompt: string, onEvent: AgentEventHandler): 'started' | 'queued' | 'queue-full' | 'shutdown' {
    if (this.shuttingDown) return 'shutdown';
    if (!this.canStart(chatKey, [userId])) {
      const q = this.queues.get(chatKey) ?? [];
      if (q.length >= this.opts.queueLimit) return 'queue-full';
      q.push({ prompt, userId, onEvent });
      this.queues.set(chatKey, q);
      try {
        this.deps.sessions.updateActivity(chatKey); // 排队也是活动——TTL 不得在等待期吞掉会话
      } catch (e) {
        // 活动时间是遥测面（W1 state 同款降级）：写失败留痕，不丢消息
        this.deps.logger.warn('session activity persist failed (queued anyway)', { chatKey, err: (e as Error).message });
      }
      return 'queued';
    }
    void this.runTurn(chatKey, chatType, [userId], prompt, onEvent, false);
    return 'started';
  }

  /** 数字/自由文本作答：写 control_response 回仍在运行的进程（写完成回调确认——P2）。
   *  作答者（群内可为非发起人——D2）计入本回合 initiators（R3-F2）；已达每用户帽的作答者
   *  被拒收（'answerer-busy'——pr-review P1：平台 ≤3 in-flight 必须执行，非仅记账跳过）。 */
  async answerPendingAsk(chatKey: string, text: string, answeringUserId?: string): Promise<'answered' | 'invalid_numeric' | 'none' | 'answerer-busy'> {
    const entry = this.pendingAsks.get(chatKey);
    if (!entry) return 'none';
    const parsed = parseNumericReply(text, entry.questions);
    let answers: Record<string, string> | null = null;
    if (parsed.kind === 'options') answers = parsed.answers;
    else if (parsed.kind === 'free_text') {
      const first = entry.questions.find((q) => q.question);
      answers = first ? { [first.question]: text.trim() } : null;
    } else return 'invalid_numeric'; // 越界/单选多挑/空——pending 保持等重试；不刷新活动（不延长 TTL）
    if (!answers || !entry.proc.stdin?.writable) {
      this.pendingAsks.delete(chatKey);
      return 'none';
    }
    // 平台帽执行（pr-review P1）：非本回合发起人且已达帽 ⇒ 拒收作答（pending 保持，稍后可重试）
    const turn = this.busy.get(chatKey);
    const isInitiator = turn?.proc === entry.proc && answeringUserId !== undefined && turn.initiators.includes(answeringUserId);
    if (answeringUserId !== undefined && !isInitiator && this.userInFlight(answeringUserId) >= this.opts.perUserInFlight) {
      this.deps.logger.warn('group answerer at per-user in-flight cap — answer deferred', { chatKey, answeringUserId });
      return 'answerer-busy';
    }
    const wrote = await writeLine(entry.proc, {
      type: 'control_response',
      response: { subtype: 'success', request_id: entry.requestId, response: { behavior: 'allow', updatedInput: { ...entry.input, answers } } },
    });
    if (!wrote) {
      this.deps.logger.warn('control_response write failed (child dying)', { chatKey });
      this.pendingAsks.delete(chatKey); // 写失败才清——此前保持 pending 可重试（code-review R2-C4）
      return 'none';
    }
    this.pendingAsks.delete(chatKey);
    try {
      this.deps.sessions.updateActivity(chatKey);
    } catch (e) {
      // 活动时间是遥测面：写失败留痕，不影响作答已成立的事实
      this.deps.logger.warn('session activity persist failed (answer kept)', { chatKey, err: (e as Error).message });
    }
    if (turn?.proc === entry.proc) {
      if (answeringUserId && !turn.initiators.includes(answeringUserId)) {
        turn.initiators.push(answeringUserId); // 群内作答者计入帽（R3-F2）——能走到这里必在帽内（上方已拒收帽满者）
      }
      if (turn.askDeadline) {
        clearTimeout(turn.askDeadline);
        turn.askDeadline = null;
      }
    }
    // 答复后重开整段流预算：ask 已闭旧流，后续输出走新流（D7——deadline 按「流段」计）
    this.armDeadline(chatKey, entry.proc);
    return 'answered';
  }

  /** 平台帽编码：每用户 in-flight = 计入其名的运行回合数（ask 等待仍在 busy——单计；群批量回合按全部发送者计）。 */
  private userInFlight(userId: string): number {
    let n = 0;
    for (const t of this.busy.values()) if (t.initiators.includes(userId)) n += 1;
    return n;
  }

  private canStart(chatKey: string, userIds: string[]): boolean {
    return !this.busy.has(chatKey)
      && this.busy.size < this.opts.maxConcurrentTurns
      && userIds.every((u) => this.userInFlight(u) < this.opts.perUserInFlight);
  }

  private claudeSpawn(): ClaudeCommand {
    const inj = this.deps.options?.claudeCommand;
    const resolved = typeof inj === 'function' ? inj() : inj;
    return resolved ?? { command: 'claude', argsPrefix: [] };
  }

  private buildArgs(resumeId: string | null): string[] {
    const args = [
      '--print', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose',
      '--permission-prompt-tool', 'stdio', '--permission-mode', 'bypassPermissions',
      '--append-system-prompt', (this.deps.options?.buildSystemPrompt ?? buildSystemPrompt)(this.deps.workspacePath),
      '--model', this.opts.model,
    ];
    if (resumeId) args.push('--resume', resumeId);
    return args;
  }

  private buildEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    return env;
  }

  private armDeadline(chatKey: string, proc: ChildProcess): void {
    const turn = this.busy.get(chatKey);
    if (!turn || turn.proc !== proc) return;
    if (turn.deadline) clearTimeout(turn.deadline);
    turn.deadline = setTimeout(() => {
      turn.deadline = null;
      timedOutProcs.add(proc); // runTurn 的 EOF/退出路径按哨兵发 TURN_TIMEOUT_ERROR
      try { proc.kill('SIGINT'); } catch { /* 已退 */ }
      void terminateChild(proc, this.opts.reapEofMs, this.opts.reapTermMs);
      this.deps.logger.warn('turn timeout, child killed', { chatKey, turnTimeoutMs: this.opts.turnTimeoutMs });
    }, this.opts.turnTimeoutMs);
    turn.deadline.unref();
  }

  private clearDeadline(chatKey: string, proc: ChildProcess): void {
    const turn = this.busy.get(chatKey);
    if (turn?.proc === proc && turn.deadline) {
      clearTimeout(turn.deadline);
      turn.deadline = null;
    }
  }

  private async runTurn(chatKey: string, chatType: 'single' | 'group', userIds: string[], prompt: string, onEvent: AgentEventHandler, freshRetry: boolean): Promise<void> {
    const ctx = { proc: null as ChildProcess | null, fullText: '', turnFinished: false };
    try {
      await this.runTurnInner(chatKey, chatType, userIds, prompt, onEvent, freshRetry, {
        onSpawned: (p) => { ctx.proc = p; },
        onText: (t) => { ctx.fullText += t; },
        markFinished: () => { ctx.turnFinished = true; },
        getText: () => ctx.fullText,
      });
      return;
    } catch (err) {
      // 外层失败生命周期（code-review C4）：会话存储/spawn 前置/流循环抛错 ⇒ 收尾不悬挂
      const e = err as Error;
      this.deps.logger.error('turn crashed', { chatKey, err: e.stack ?? e.message });
      const proc = ctx.proc;
      if (proc) {
        if (!ctx.turnFinished) {
          try { await onEvent({ type: 'turn_failed', chatKey, error: e.message }); } catch { /* 消费方已坏 */ }
        }
        if (this.pendingAsks.get(chatKey)?.proc === proc) this.pendingAsks.delete(chatKey); // code-review R2-C4
        const turn = this.busy.get(chatKey);
        if (turn?.proc === proc) {
          if (turn.deadline) clearTimeout(turn.deadline);
          if (turn.askDeadline) clearTimeout(turn.askDeadline);
          turn.terminating = true;
        }
        try { proc.kill('SIGINT'); } catch { /* 已退 */ }
        await terminateChild(proc, this.opts.reapEofMs, this.opts.reapTermMs);
        if (this.busy.get(chatKey)?.proc === proc) this.busy.delete(chatKey);
      } else if (!ctx.turnFinished) {
        try { await onEvent({ type: 'turn_failed', chatKey, error: e.message }); } catch { /* 消费方已坏 */ }
      }
      this.scheduleAfterRelease(chatKey);
    }
  }

  private async runTurnInner(chatKey: string, chatType: 'single' | 'group', userIds: string[], prompt: string, onEvent: AgentEventHandler, freshRetry: boolean,
    hooks: { onSpawned: (p: ChildProcess) => void; onText: (t: string) => void; markFinished: () => void; getText: () => string }): Promise<void> {
    const session = this.deps.sessions.resumable(chatKey, chatType, this.opts.idleTtlMs);
    const resumeId = freshRetry ? null : session.claudeSessionId;
    const claude = this.claudeSpawn();
    const proc = spawn(claude.command, [...claude.argsPrefix, ...this.buildArgs(resumeId)], {
      cwd: this.deps.workspacePath,
      env: this.buildEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    hooks.onSpawned(proc);
    this.busy.set(chatKey, { proc, initiators: [...new Set(userIds)], deadline: null, askDeadline: null, terminating: false });
    this.armDeadline(chatKey, proc);
    this.deps.logger.info('turn starting', { chatKey, resume: resumeId ?? '(fresh)', pid: proc.pid });
    // code-review C5/R2-C3：stdin 异步错误（EPIPE）哨兵化——后续写拒收、留痕不冒 unhandled
    proc.stdin?.on('error', (e: Error) => {
      stdinFailedProcs.add(proc);
      this.deps.logger.warn('claude stdin failed (writes will be rejected)', { chatKey, err: e.message });
    });

    let stderrBuf = '';
    proc.stderr?.on('data', (c: Buffer) => { stderrBuf += c.toString(); });
    let spawnError = ''; // ENOENT 等 spawn 期失败（无 exit 跟随）
    proc.on('error', (err: Error & { code?: string }) => { spawnError = err.message; });
    let turnFinished = false;

    if (!(await writeLine(proc, { type: 'user', message: { role: 'user', content: prompt } }))) {
      // pr-review P2：首条 prompt 写不进（管道死）⇒ 回合无法成立——终止并报失败，不等到超时
      throw new Error('claude stdin write failed at turn start (child pipe dead)');
    }

    const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity, terminal: false });
    proc.once('error', () => rl.close()); // bun：spawn 失败 stdout 无 EOF——显式关
    let stdoutGrace: NodeJS.Timeout | undefined;
    proc.once('exit', () => {
      stdoutGrace = setTimeout(() => rl.close(), 1_000);
      stdoutGrace.unref();
    });

    try {
      for await (const line of rl) {
        const event = parseStreamLine(line);
        if (!event) continue;
        if (typeof event['session_id'] === 'string' && event['session_id']) {
          this.deps.sessions.setClaudeSessionId(chatKey, event['session_id'] as string);
          this.deps.sessions.updateActivity(chatKey);
        }
        if (event.type === 'control_request') {
          const c = classifyControlRequest(event);
          if (c.type === 'ask_user') {
            if (this.busy.get(chatKey)?.proc !== proc) continue; // 迟到缓冲行不属当代
            const questions = extractAskUserQuestions(c.input ?? {});
            this.pendingAsks.set(chatKey, { requestId: c.requestId, input: c.input ?? {}, questions, proc });
            this.clearDeadline(chatKey, proc); // ask 等待不吃流预算（流已闭；答复时重臂新流预算）
            this.armAskTtl(chatKey, proc);     // 无人作答也要释放槽位（code-review C3）
            await onEvent({ type: 'ask', chatKey, questions }); // 闭流帧发完才继续读（背压，F9）
          } else {
            void writeLine(proc, {
              type: 'control_response',
              response: { subtype: 'success', request_id: c.requestId, response: { behavior: 'allow', updatedInput: c.input ?? {} } },
            }).then((ok) => {
              if (!ok) this.deps.logger.warn('control_response write failed (child dying)', { chatKey });
            });
          }
          continue;
        }
        if (event.type === 'control_cancel_request') {
          if (this.pendingAsks.get(chatKey)?.proc === proc) {
            this.pendingAsks.delete(chatKey);
            const turn = this.busy.get(chatKey);
            if (turn?.proc === proc && turn.askDeadline) { clearTimeout(turn.askDeadline); turn.askDeadline = null; }
            this.armDeadline(chatKey, proc);
          }
          continue;
        }
        if (event.type === 'assistant') {
          const text = extractTextFromAssistant(event);
          if (text) {
            hooks.onText(text);
            void onEvent({ type: 'text_delta', chatKey, text });
          }
          continue;
        }
        if (event.type === 'result') {
          if (event.subtype === 'tool_result') continue;
          const isError = event.is_error === true || event.subtype === 'error_during_execution';
          const errors = Array.isArray(event.errors) ? (event.errors as unknown[]).map(String) : [];
          const resultText = typeof event.result === 'string' ? event.result : '';
          if (isError && resumeId && (errors.some((s) => s.includes('No conversation found')) || resultText.includes('No conversation found'))) {
            turnFinished = true; // 本代以提示收场，紧跟 fresh 重试
            hooks.markFinished(); // pr-review P4：终态前标记——消费方回调抛错不得触发重复终态
            resumeNotFoundProcs.add(proc);
            await onEvent({ type: 'text_delta', chatKey, text: '⚠️ 会话恢复失败，正在重新开始对话…\n\n' });
            break;
          }
          turnFinished = true;
          hooks.markFinished(); // pr-review P4
          if (isError) {
            await onEvent({ type: 'turn_failed', chatKey, error: errors.join('; ') || resultText || `claude result error (${String(event.subtype)})` });
          } else {
            // turn_input_required 亦按完成收（bypass+stdio 下不应出现；出现即回合已终）
            await onEvent({ type: 'turn_complete', chatKey, finalText: hooks.getText() });
          }
          break;
        }
        if (event.type === 'error') {
          turnFinished = true;
          hooks.markFinished(); // pr-review P4
          await onEvent({ type: 'turn_failed', chatKey, error: String(event.error ?? 'unknown stream error') });
          break;
        }
        if (isTerminalEvent(event)) break;
      }
    } finally {
      if (stdoutGrace) clearTimeout(stdoutGrace);
    }

    // EOF 无终态：有界等 exit 再判读（stream-end 常先于 exit 事件）
    if (!turnFinished && !spawnError && proc.exitCode === null && proc.signalCode === null) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => { proc.removeListener('exit', onExit); resolve(); }, 300);
        t.unref();
        const onExit = () => { clearTimeout(t); resolve(); };
        proc.once('exit', onExit);
      });
    }
    // 失败面（plan 评审 F3）：EOF 无终态 ⇒ 必报 turn_failed（exit 0 也不留孤儿流）；
    // 超时哨兵优先；spawn 失败（ENOENT）单独可识别。
    if (!turnFinished) {
      hooks.markFinished(); // pr-review P4：EOF 失败路径也是终态——回调抛错不得触发重复终态
      if (expiredAskProcs.has(proc)) {
        // ask 过期击杀（code-review C2）：不发通用失败——过期语义由 ask_expired 承载
        await onEvent({ type: 'ask_expired', chatKey });
      } else if (timedOutProcs.has(proc)) {
        await onEvent({ type: 'turn_failed', chatKey, error: TURN_TIMEOUT_ERROR });
      } else if (spawnError) {
        await onEvent({ type: 'turn_failed', chatKey, error: `claude spawn failed: ${spawnError}` });
      } else if (proc.exitCode !== null && proc.exitCode !== 0) {
        await onEvent({ type: 'turn_failed', chatKey, error: stderrBuf.trim().slice(0, 300) || `claude exited with code ${proc.exitCode}` });
      } else {
        await onEvent({ type: 'turn_failed', chatKey, error: 'claude exited without a terminal stream event' });
      }
      turnFinished = true;
    }

    this.clearDeadline(chatKey, proc);
    const cur = this.busy.get(chatKey);
    if (cur?.proc === proc && cur.askDeadline) { clearTimeout(cur.askDeadline); cur.askDeadline = null; }
    if (this.pendingAsks.get(chatKey)?.proc === proc) this.pendingAsks.delete(chatKey);
    // 收割完成才放行槽位/排 drain（plan 评审 F10 + code-review C1：terminating 持槽防直接 submit 并行 spawn）
    if (cur?.proc === proc) cur.terminating = true;
    await terminateChild(proc, this.opts.reapEofMs, this.opts.reapTermMs);
    if (this.busy.get(chatKey)?.proc === proc) this.busy.delete(chatKey);

    if (!this.shuttingDown && resumeNotFoundProcs.has(proc)) {
      void this.runTurn(chatKey, chatType, userIds, prompt, onEvent, true); // resume 失败重试（恰好一次）——沿用当代 initiators
      return;
    }
    this.scheduleAfterRelease(chatKey);
  }

  /** ask 等待期的会话 TTL 计时器（code-review C3）：无人作答也按 TTL 释放槽位——
   *  到点走 killAskTurn（哨兵 ⇒ runTurn 发 ask_expired，不发通用失败）。 */
  private armAskTtl(chatKey: string, proc: ChildProcess): void {
    const turn = this.busy.get(chatKey);
    if (!turn || turn.proc !== proc) return;
    if (turn.askDeadline) clearTimeout(turn.askDeadline);
    turn.askDeadline = setTimeout(() => {
      turn.askDeadline = null;
      if (this.pendingAsks.get(chatKey)?.proc === proc) this.pendingAsks.delete(chatKey);
      this.killAskTurn(chatKey, proc, 'pending ask abandoned (session ttl) — slot released');
    }, this.opts.idleTtlMs);
    turn.askDeadline.unref();
  }

  /** 槽位释放后的调度：本 chat 队列优先（批量回合），再跨 chat FIFO 提升其他排队者（plan 评审 F1）。 */
  private scheduleAfterRelease(fromChatKey: string): void {
    if (this.shuttingDown) return;
    for (const chatKey of [fromChatKey, ...this.queues.keys()]) {
      if (this.busy.has(chatKey)) continue;
      const q = this.queues.get(chatKey);
      if (!q || q.length === 0) continue;
      const last = q[q.length - 1]!; // 最新消息的回调持有最新 replyTo（plan 评审 F5：批量回合回执绑最新回调）
      const userIds = [...new Set(q.map((e) => e.userId))]; // 全部发送者计并发帽（R2-F8）
      if (!this.canStart(chatKey, userIds)) continue;
      this.queues.delete(chatKey);
      void this.runTurn(chatKey, this.chatTypeOf(chatKey), userIds, buildQueuedBatchPrompt(q.map((e) => e.prompt)), last.onEvent, false);
      return; // 一次释放一个槽位
    }
  }

  private chatTypeOf(chatKey: string): 'single' | 'group' {
    return chatKey.startsWith('group:') ? 'group' : 'single';
  }

  async closeAll(): Promise<void> {
    this.shuttingDown = true;
    const turns = [...this.busy.values()];
    for (const t of turns) {
      if (t.deadline) clearTimeout(t.deadline);
      if (t.askDeadline) clearTimeout(t.askDeadline);
    }
    const procs = turns.map((t) => t.proc);
    this.busy.clear();
    this.pendingAsks.clear();
    this.queues.clear();
    for (const proc of procs) {
      try { proc.kill('SIGINT'); } catch { /* 已退 */ }
    }
    await Promise.allSettled(procs.map((p) => terminateChild(p, this.opts.reapEofMs, this.opts.reapTermMs)));
  }
}
