# wechatbot W2（Agent session layer：spawn claude、per-chat 会话 + TTL resume、stream bridge、AskUser 文本回退）Implementation Plan

**Goal:** 在 W1 transport 骨架之上落地 agent 会话层：每 chat（单聊 per-user / 群聊 per-group）一个 claude 会话，TTL 内 `--resume` 续接、过期新建；agent 输出经 `aibot_respond_msg` 流式回传（恒定 `stream.id`、节流刷新、`finish=true` 收尾、10 分钟硬护栏）；每 chat 串行队列；AskUserQuestion 降级为编号文本 + 数字回复。

**Architecture:** 四模块分层（D1）：`src/agent/parser.ts`（纯函数：stream-json 解析 / ask 渲染 / 数字回复解析 / 字节安全截断）、`src/agent/session-store.ts`（每 chat 会话 JSON + 惰性 TTL，原子写 0600，base64url 文件名）、`src/agent/manager.ts`（spawn/busy/队列/收割梯子/pending ask/绝对超时——**transport 无关**，注入 `claudeCommand`）、`src/handlers/agent.ts`（transport↔manager 接线 + WeCom 流桥：streamId/节流/会话级限流 30min+1000h/字节上限/错误映射）。Gateway 把 `EchoHandler` 换成 `AgentHandler`（`BotHandler` 接口）。测试双桩：mock WeCom WS 服务端（W1 既有）+ fake claude（node 脚本，注入 `claudeCommand`）。

**Tech Stack:** 同 W1：bun 1.3.14 + TypeScript 5 strict（node builtins，零 Bun 专属 API）+ `@wecom/aibot-node-sdk@1.0.7`（钉死）+ `bun test` + `tsc --noEmit` + `bun build --target=node`。claude CLI 2.1.153 协议（feishubot 生产源码实核：`--print --output-format stream-json --input-format stream-json --verbose --permission-prompt-tool stdio --permission-mode bypassPermissions` + stdin user 消息 + stdout NDJSON + control_request/control_response）。

**Spec:** `docs/issues/2/decisions.md`

## Global Constraints

- AC1: 单聊文本往返流式回传真实 agent 回复，终帧 `finish=true`（spec S1）。
- AC2: TTL 内跟进 `--resume` 同一会话；超 TTL 新会话（S2）。
- AC3: 同用户两条急速消息串行排队；无交错流（批回合回执，流不重叠）。
- AC4: AskUserQuestion 渲染为编号文本清单；数字回复（含 `1,3` 多选）解析回 tool result（S13）。
- AC5: 超时回合干净收流（终帧 + `finish=true` + 杀子进程），不悬挂。超时预算按**流段**计（plan 评审 R2-F2 显式化）：spawn→本段终局（ask 闭流或回合终态）默认 570s（平台 10min − 30s 边距）；ask 等待期无 deadline（进程寿命由会话 TTL 惰性约束 + closeAll 兜底）；作答后续段重获整段预算（新流新预算）。
- 平台护栏：每用户 ≤3 in-flight（运行回合 + ask 等待按"运行回合"单计——ask 期仍在 busy；跨会话计数）；会话级限流 30 msg/min 与 1000/h（刷新帧预算耗尽即丢——幂等无损；终帧有界等待预算 ≤25s，到顶才直接发送并告警——孤儿流比超限更糟，D5 修订）。
- 流内容字节上限 20000（SDK 硬限 20480），`Buffer.byteLength` 按字节截断、不切 UTF-8 序列、预留标记空间（D5）。
- src/ 只用 node 内建模块；fake claude helper 用 `.mjs` + node 内建（被 spawn 的子进程不得依赖 bun:test）。
- feishubot #62 教训：所有 IO/子进程错误记日志并传播，禁止吞掉；用户可见错误通用化（细节进日志）。
- config 键名 `session_idle_ttl_minutes` 按 issue 原文（SRS 键名优先于仓库 camelCase 风格，一处显式例外）；其余新键（`claudeModel`、`maxConcurrentTurns`）走 camelCase。
- **每实现任务提交门槛统一 `bun run typecheck && bun test tests/unit tests/integration` 全绿**；每任务独立提交。
- 工作目录：`/home/ubuntu/wiki-symphony-ws/projects/wechatbot-ws/workspaces/issues/2`（下称 `$WS`）。
- FLAGGED-FOR-HUMAN（decisions.md 汇总）：权限姿态（bypassPermissions 镜像 feishubot 生产）、群 ask 作答权（任何成员可答）、真实平台验证（WeCom 流刷新语义 / glm-5.3-flash 可用性 / 真实 resume）——列入 PR 描述的人工核验清单。

## Tasks

**执行顺序（硬约束）**：Task 1 → 2 → 3 → 4（Checkpoint A）→ 5 → 6 → 7（Checkpoint B）→ 8 → 9（Checkpoint C）。

---

### Task 1: config 扩展（TTL / 模型 / 并发帽）

**Files:**
- Modify: `src/config.ts:7-11`（BotConfig 接口）、`src/config.ts:55-85`（parseConfig）
- Test: `tests/unit/config.test.ts`（追加用例）

**Interfaces:**
- Produces: `BotConfig.sessionIdleTtlMinutes?: number`（>0 整数，缺省 60）、`BotConfig.claudeModel?: string`（trim 后非空，缺省 `'glm-5.3-flash'`）、`BotConfig.maxConcurrentTurns?: number`（>0 整数，缺省 4）；常量 `DEFAULT_SESSION_IDLE_TTL_MINUTES`、`DEFAULT_CLAUDE_MODEL`、`DEFAULT_MAX_CONCURRENT_TURNS` 从 `src/config.ts` 导出。

- [x] **Step 1: 追加失败测试**（`tests/unit/config.test.ts` 末尾追加；沿用该文件既有的临时目录写 config.json 模式）

```ts
import { DEFAULT_CLAUDE_MODEL, DEFAULT_MAX_CONCURRENT_TURNS, DEFAULT_SESSION_IDLE_TTL_MINUTES } from '../../src/config';

describe('W2 config keys', () => {
  test('缺省：TTL=60、model=glm-5.3-flash、maxConcurrentTurns=4', () => {
    writeConfig({}); // 既有 helper：写 JSON 进临时 .bot/config.json 后 loadWorkspace
    const cfg = loadCfg(); // 既有 helper
    expect(cfg.sessionIdleTtlMinutes).toBe(60);
    expect(cfg.claudeModel).toBe(DEFAULT_CLAUDE_MODEL); // 'glm-5.3-flash'
    expect(cfg.maxConcurrentTurns).toBe(4);
  });
  test('session_idle_ttl_minutes 合法整数生效；非整数/<=0 拒绝', () => {
    writeConfig({ session_idle_ttl_minutes: 30 });
    expect(loadCfg().sessionIdleTtlMinutes).toBe(30);
    writeConfig({ session_idle_ttl_minutes: 1.5 });
    expect(loadThrows(/session_idle_ttl_minutes/));
    writeConfig({ session_idle_ttl_minutes: 0 });
    expect(loadThrows(/session_idle_ttl_minutes/));
  });
  test('claudeModel：合法字符串生效；空串/空白/非字符串拒绝', () => {
    writeConfig({ claudeModel: 'glm-5.3' });
    expect(loadCfg().claudeModel).toBe('glm-5.3');
    writeConfig({ claudeModel: '  ' });
    expect(loadThrows(/claudeModel/));
    writeConfig({ claudeModel: 42 });
    expect(loadThrows(/claudeModel/));
  });
  test('maxConcurrentTurns：合法整数生效；非整数/<=0 拒绝', () => {
    writeConfig({ maxConcurrentTurns: 8 });
    expect(loadCfg().maxConcurrentTurns).toBe(8);
    writeConfig({ maxConcurrentTurns: 0 });
    expect(loadThrows(/maxConcurrentTurns/));
  });
});
```

- [x] **Step 2: 跑测确认 FAIL** — Run: `bun test tests/unit/config.test.ts`
  Expected: FAIL（`sessionIdleTtlMinutes` 等属性不存在 / 导出缺失——typecheck 亦炸，属预期）
- [x] **Step 3: 实现**（`src/config.ts`）

```ts
export interface BotConfig {
  logLevel: LogLevel;
  heartbeatInterval?: number;
  maxReconnectAttempts?: number;
  /** W2：会话空闲 TTL（分钟）——issue 原文键名，SRS 键名优先于仓库 camelCase 风格 */
  sessionIdleTtlMinutes?: number;
  /** W2：claude --model 值 */
  claudeModel?: string;
  /** W2：全局并发回合帽（资源保护；平台每用户帽是独立常量） */
  maxConcurrentTurns?: number;
}

export const DEFAULT_SESSION_IDLE_TTL_MINUTES = 60;
export const DEFAULT_CLAUDE_MODEL = 'glm-5.3-flash';
export const DEFAULT_MAX_CONCURRENT_TURNS = 4;
```

parseConfig 末尾追加（沿用既有 numKey 循环风格，`session_idle_ttl_minutes` 与 `maxConcurrentTurns` 进整数循环并各加 >0 门）：

```ts
  for (const numKey of ['heartbeatInterval', 'maxReconnectAttempts', 'session_idle_ttl_minutes', 'maxConcurrentTurns'] as const) {
    const v = raw[numKey];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isInteger(v)) {
      throw new ConfigError(`${numKey} must be an integer in ${path}`);
    }
    if ((numKey === 'heartbeatInterval' || numKey === 'session_idle_ttl_minutes' || numKey === 'maxConcurrentTurns') && v <= 0) {
      throw new ConfigError(`${numKey} must be > 0 in ${path}`);
    }
    if (numKey === 'maxReconnectAttempts' && v < -1) {
      throw new ConfigError(`maxReconnectAttempts must be -1 (infinite) or >= 0 in ${path}`);
    }
    cfg[numKey] = v;
  }
  if (raw['session_idle_ttl_minutes'] !== undefined) cfg.sessionIdleTtlMinutes = raw['session_idle_ttl_minutes'];
  if (raw['maxConcurrentTurns'] !== undefined) cfg.maxConcurrentTurns = raw['maxConcurrentTurns'];
  if (raw['claudeModel'] !== undefined) {
    const m = raw['claudeModel'];
    if (typeof m !== 'string' || m.trim() === '') {
      throw new ConfigError(`claudeModel must be a non-empty string in ${path}`);
    }
    cfg.claudeModel = m.trim();
  }
  if (cfg.sessionIdleTtlMinutes === undefined) cfg.sessionIdleTtlMinutes = DEFAULT_SESSION_IDLE_TTL_MINUTES;
  if (cfg.claudeModel === undefined) cfg.claudeModel = DEFAULT_CLAUDE_MODEL;
  if (cfg.maxConcurrentTurns === undefined) cfg.maxConcurrentTurns = DEFAULT_MAX_CONCURRENT_TURNS;
```

**执行偏差（r1）**：parseConfig 只做**校验**、不填默认值——三键缺省保持 `undefined`，默认值由 `AgentManager` 构造时持有（manager 代码本就自带 `?? DEFAULT_*` 兜底，单一事实源）。理由：计划原案在 parseConfig 填默认值会破坏 W1 既有 exact-shape 断言（`config).toEqual({ logLevel: 'info' })`），且 manager 已拥有同款默认。`DEFAULT_*` 常量不进 config.ts。

（注：numKey 联合类型含 snake_case 键时 `cfg[numKey] = v` 需要键名映射——实现时按上式先循环校验、再显式赋值三个键，避免索引类型冲突；typecheck 必须零错误。）

- [x] **Step 4: 跑测确认 PASS** — Run: `bun run typecheck && bun test tests/unit tests/integration`
  Expected: PASS 全绿
- [x] **Step 5: Commit** — `git add src/config.ts tests/unit/config.test.ts && git commit -m "feat(config): W2 keys session_idle_ttl_minutes/claudeModel/maxConcurrentTurns with strict validation"`

---

### Task 2: transport 补群聊 chatId 解析

**Files:**
- Modify: `src/transport/types.ts:3-9`（InboundTextMessage）
- Modify: `src/transport/wecom-sdk-adapter.ts:68-82`（message.text 解析）
- Modify: `tests/helpers/mock-wecom-server.ts:49-59`（pushTextMessage 支持群帧）
- Test: `tests/integration/transport.test.ts:81-97`（DTO 断言更新 + 群帧新用例）

**Interfaces:**
- Produces: `InboundTextMessage.chatId?: string`（仅群聊在场；群帧缺 `chatid` ⇒ adapter debug 日志 + 忽略该帧）；`MockWecomServer.pushTextMessage(reqId, {msgid, userId, content, chatType?, chatid?})`。

- [x] **Step 1: 更新 DTO 断言 + 新增群帧失败测试**（`tests/integration/transport.test.ts`）

  既有用例 `textMessage 事件携带解析后的 DTO 与 reqId` 的期望对象改为含 `chatId: undefined`：

```ts
  expect(msg).toEqual({
    type: 'textMessage',
    message: { msgid: 'm1', chatType: 'single', userId: 'u1', chatId: undefined, content: 'hello', replyTo: { __brand: 'ReplyRef', reqId: 'req-1' } },
  });
```

  追加用例：

```ts
test('群聊帧：chatid 解析进 chatId；缺 chatid 的群帧被忽略', async () => {
  const srv = new MockWecomServer();
  const { url } = await srv.start();
  const t = new WecomSdkTransport({ botId: 'b', secret: 's', wsUrl: url, ...FAST });
  const rec = recorder();
  t.on(rec.push);
  await t.start();
  srv.pushTextMessage('req-g1', { msgid: 'g1', userId: 'u1', content: 'hi group', chatType: 'group', chatid: 'wrGroupId' });
  await waitUntil(() => rec.events.some((e) => e.type === 'textMessage'));
  const msg = rec.events.find((e) => e.type === 'textMessage')!;
  if (msg.type !== 'textMessage') throw new Error('unreachable');
  expect(msg.message.chatType).toBe('group');
  expect(msg.message.chatId).toBe('wrGroupId');
  // 缺 chatid 的群帧：忽略（无 textMessage 事件）
  srv.pushTextMessage('req-g2', { msgid: 'g2', userId: 'u1', content: 'bad', chatType: 'group' });
  await new Promise((r) => setTimeout(r, 300));
  expect(rec.events.filter((e) => e.type === 'textMessage').length).toBe(1);
  await t.stop();
  await srv.stop();
});
```

- [x] **Step 2: 跑测确认 FAIL** — Run: `bun test tests/integration/transport.test.ts`
  Expected: FAIL（DTO 无 chatId 字段；pushTextMessage 不认 chatType/chatid）
- [x] **Step 3: 实现**

  `src/transport/types.ts`：

```ts
export interface InboundTextMessage {
  msgid: string;
  chatType: 'single' | 'group';
  /** 仅群聊在场（SDK BaseMessage.chatid）；群帧缺失时 adapter 忽略该帧 */
  chatId?: string;
  userId: string;
  content: string;
  replyTo: ReplyRef;
}
```

  `src/transport/wecom-sdk-adapter.ts` message.text handler：

```ts
      client.on('message.text', (frame: WsFrame) => {
        const body = frame.body as unknown as {
          msgid: string; chattype?: 'single' | 'group'; chatid?: string;
          from: { userid: string }; text: { content: string };
        };
        const chatType = body.chattype ?? 'single';
        if (chatType === 'group' && !body.chatid) {
          // 群帧必带 chatid（SDK .d.ts：仅群聊返回）——缺失即无法定址会话，忽略并留痕
          this.opts.logger?.debug?.('group text without chatid ignored', body.msgid);
          return;
        }
        this.emit({
          type: 'textMessage',
          message: {
            msgid: body.msgid,
            chatType,
            ...(chatType === 'group' ? { chatId: body.chatid } : {}),
            userId: body.from?.userid ?? 'unknown',
            content: body.text?.content ?? '',
            replyTo: refFromFrame(frame),
          },
        });
      });
```

  `tests/helpers/mock-wecom-server.ts` pushTextMessage：

```ts
  pushTextMessage(reqId: string, msg: { msgid: string; userId: string; content: string; chatType?: 'single' | 'group'; chatid?: string }): void {
    this.broadcast({
      cmd: 'aibot_msg_callback',
      headers: { req_id: reqId },
      body: {
        msgid: msg.msgid, aibotid: 'bot-mock', chattype: msg.chatType ?? 'single',
        ...(msg.chatType === 'group' && msg.chatid ? { chatid: msg.chatid } : {}),
        from: { userid: msg.userId }, msgtype: 'text', text: { content: msg.content },
        create_time: Math.floor(Date.now() / 1000),
      },
    });
  }
```

- [x] **Step 4: 跑测确认 PASS** — Run: `bun run typecheck && bun test tests/unit tests/integration`
  Expected: PASS（echo.test.ts 的既有用例不受影响——单聊帧形状不变）
- [x] **Step 5: Commit** — `git add src/transport/types.ts src/transport/wecom-sdk-adapter.ts tests/helpers/mock-wecom-server.ts tests/integration/transport.test.ts && git commit -m "feat(transport): parse group chatid into chatId; ignore group frames without it"`

---

### Task 3: `src/agent/parser.ts`（纯函数层）

**Files:**
- Create: `src/agent/parser.ts`
- Test: `tests/unit/parser.test.ts`

**Interfaces:**
- Produces（后续任务消费的精确签名）:
  - `interface StreamEvent { type: string; [k: string]: unknown }`
  - `parseStreamLine(line: string): StreamEvent | null`
  - `isTerminalEvent(e: StreamEvent): boolean`
  - `extractTextFromAssistant(e: StreamEvent): string | null`
  - `classifyControlRequest(e: StreamEvent): { type: 'auto_approve' | 'ask_user'; requestId: string; toolName?: string; input?: Record<string, unknown> }`
  - `interface AskQuestionView { question: string; options?: Array<{ label: string; description?: string }>; multiSelect?: boolean }`
  - `extractAskUserQuestions(input: Record<string, unknown>): AskQuestionView[]`
  - `renderAskText(questions: AskQuestionView[]): string`
  - `parseNumericReply(text: string, questions: AskQuestionView[]): { kind: 'options'; answers: Record<string, string> } | { kind: 'free_text' } | { kind: 'invalid_numeric' }`
  - `buildContextPreamble(m: { userId: string; chatKey: string; chatType: 'single' | 'group' }): string`
  - `buildQueuedBatchPrompt(messages: string[]): string`
  - `truncateUtf8(text: string, maxBytes: number, marker?: string): string`

- [x] **Step 1: 写失败测试**（`tests/unit/parser.test.ts`，覆盖对抗面：畸形行/多题扁平编号/多选/越界/全角逗号/UTF-8 截断边界）

```ts
import { test, expect } from 'bun:test';
import {
  parseStreamLine, isTerminalEvent, extractTextFromAssistant, classifyControlRequest,
  extractAskUserQuestions, renderAskText, parseNumericReply, buildContextPreamble,
  buildQueuedBatchPrompt, truncateUtf8,
} from '../../src/agent/parser';

const TWO_Q = [
  { question: '用哪个库？', options: [{ label: 'bun' }, { label: 'node' }] },
  { question: '要不要日志？', options: [{ label: '要' }, { label: '不要' }], multiSelect: true },
];

test('parseStreamLine：合法 JSON 对象放行；空行/非 JSON/非对象拒绝', () => {
  expect(parseStreamLine('{"type":"result"}')!.type).toBe('result');
  expect(parseStreamLine('')).toBeNull();
  expect(parseStreamLine('not json')).toBeNull();
  expect(parseStreamLine('[1,2]')).toBeNull();
});

test('isTerminalEvent：result(非 tool_result)/error 终态；tool_result 非终态', () => {
  expect(isTerminalEvent({ type: 'result', subtype: 'success' })).toBe(true);
  expect(isTerminalEvent({ type: 'error' })).toBe(true);
  expect(isTerminalEvent({ type: 'result', subtype: 'tool_result' })).toBe(false);
  expect(isTerminalEvent({ type: 'assistant' })).toBe(false);
});

test('extractTextFromAssistant：取第一个 text block', () => {
  const e = { type: 'assistant', message: { content: [{ type: 'thinking' }, { type: 'text', text: '答案' }] } };
  expect(extractTextFromAssistant(e)).toBe('答案');
  expect(extractTextFromAssistant({ type: 'assistant', message: { content: 'plain' } })).toBeNull();
});

test('classifyControlRequest：can_use_tool+AskUserQuestion ⇒ ask_user；其余 auto_approve', () => {
  const ask = { type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: {} } };
  expect(classifyControlRequest(ask)).toMatchObject({ type: 'ask_user', requestId: 'r1' });
  const bash = { type: 'control_request', request_id: 'r2', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} } };
  expect(classifyControlRequest(bash).type).toBe('auto_approve');
});

test('extractAskUserQuestions：字段归一；questions 缺失返回 []', () => {
  const qs = extractAskUserQuestions({ questions: [{ question: 'Q', options: [{ label: 'a', description: 'd' }], multiSelect: true }] });
  expect(qs).toEqual([{ question: 'Q', options: [{ label: 'a', description: 'd' }], multiSelect: true }]);
  expect(extractAskUserQuestions({})).toEqual([]);
});

test('renderAskText：扁平编号跨题 + multiSelect 注记 + 底部回复指引', () => {
  const text = renderAskText(TWO_Q);
  expect(text).toContain('1. bun');
  expect(text).toContain('2. node');
  expect(text).toContain('3. 要（可多选）');
  expect(text).toContain('4. 不要');
  expect(text).toMatch(/回复数字/);
  expect(text).toContain('1,3');
});

test('parseNumericReply：单选/多选/跨题分配/全角逗号', () => {
  expect(parseNumericReply('1', TWO_Q)).toEqual({ kind: 'options', answers: { '用哪个库？': 'bun' } });
  expect(parseNumericReply('2', TWO_Q)).toEqual({ kind: 'options', answers: { '用哪个库？': 'node' } });
  expect(parseNumericReply(' 1,3 ', TWO_Q)).toEqual({ kind: 'options', answers: { '用哪个库？': 'bun', '要不要日志？': '要' } });
  expect(parseNumericReply('3、4', TWO_Q)).toEqual({ kind: 'options', answers: { '要不要日志？': '要, 不要' } });
});

test('parseNumericReply：非数字 ⇒ free_text；越界/单选多挑/空 ⇒ invalid_numeric', () => {
  expect(parseNumericReply('用 bun 吧', TWO_Q).kind).toBe('free_text');
  expect(parseNumericReply('5', TWO_Q).kind).toBe('invalid_numeric');
  expect(parseNumericReply('0', TWO_Q).kind).toBe('invalid_numeric');
  expect(parseNumericReply('1,2', TWO_Q).kind).toBe('invalid_numeric'); // 第一题非 multiSelect 却两项
  expect(parseNumericReply('', TWO_Q).kind).toBe('invalid_numeric');
});

test('buildContextPreamble：单聊 p2p / 群聊 group，键序 sender,userid,chat', () => {
  expect(buildContextPreamble({ userId: 'u9', chatKey: 'single:u9', chatType: 'single' }))
    .toBe('[Context: sender=u9, userid=u9, chat=u9 (p2p)]\n\n');
  expect(buildContextPreamble({ userId: 'u9', chatKey: 'group:wr1', chatType: 'group' }))
    .toBe('[Context: sender=u9, userid=u9, chat=wr1 (group)]\n\n');
});

test('buildQueuedBatchPrompt：单条透传；多条带框架', () => {
  expect(buildQueuedBatchPrompt(['x'])).toBe('x');
  const two = buildQueuedBatchPrompt(['a', 'b']);
  expect(two).toContain('2 条排队消息');
  expect(two).toContain('【消息 1】\na');
  expect(two).toContain('【消息 2】\nb');
});

test('truncateUtf8：字节预算内原样；超限截断不切代理对且带标记', () => {
  expect(truncateUtf8('abc', 10)).toBe('abc');
  const ascii = 'a'.repeat(100);
  const out = truncateUtf8(ascii, 20);
  expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(20);
  expect(out).toContain('…[截断]');
  const cjk = '汉'.repeat(50); // 每字 3 字节
  const out2 = truncateUtf8(cjk, 20); // 6 字 18B + 标记（'…[截断]' = 3+9 = 12B？按字节数预算内收）
  expect(Buffer.byteLength(out2, 'utf8')).toBeLessThanOrEqual(20);
  // 不切代理对：emoji 4 字节
  const emoji = '😀'.repeat(30);
  const out3 = truncateUtf8(emoji, 21);
  expect(Buffer.byteLength(out3, 'utf8')).toBeLessThanOrEqual(21);
  expect(Buffer.from(out3, 'utf8').subarray(0, -1).toString('utf8')).not.toContain('�'); // 去掉标记后无替换符
});
```

- [x] **Step 2: 跑测确认 FAIL** — Run: `bun test tests/unit/parser.test.ts`
  Expected: FAIL（模块不存在）
- [x] **Step 3: 实现 `src/agent/parser.ts`**

```ts
import type { InboundTextMessage } from '../transport/types';

export interface StreamEvent { type: string; [k: string]: unknown }

export function parseStreamLine(line: string): StreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object' && typeof (parsed as StreamEvent).type === 'string') {
      return parsed as StreamEvent;
    }
    return null;
  } catch {
    return null;
  }
}

export function isTerminalEvent(e: StreamEvent): boolean {
  if (e.type === 'result' && e.subtype === 'tool_result') return false;
  return e.type === 'result' || e.type === 'error';
}

export function extractTextFromAssistant(e: StreamEvent): string | null {
  const content = (e as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: string }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string') {
      return (block as { text: string }).text;
    }
  }
  return null;
}

export function classifyControlRequest(e: StreamEvent): {
  type: 'auto_approve' | 'ask_user'; requestId: string; toolName?: string; input?: Record<string, unknown>;
} {
  const requestId = String(e['request_id'] ?? '');
  const request = e['request'] as StreamEvent | undefined;
  if (!request || (request as { subtype?: unknown }).subtype !== 'can_use_tool') {
    return { type: 'auto_approve', requestId };
  }
  const toolName = (request as { tool_name?: unknown }).tool_name as string | undefined;
  const input = (request as { input?: unknown }).input as Record<string, unknown> | undefined;
  if (toolName === 'AskUserQuestion') return { type: 'ask_user', requestId, toolName, input };
  return { type: 'auto_approve', requestId, toolName, input };
}

export interface AskQuestionView {
  question: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

export function extractAskUserQuestions(input: Record<string, unknown>): AskQuestionView[] {
  const questions = input['questions'] as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(questions)) return [];
  return questions.map((q) => ({
    question: typeof q['question'] === 'string' ? q['question'] : '',
    options: Array.isArray(q['options'])
      ? (q['options'] as Array<Record<string, unknown>>).map((o) => ({
          label: typeof o['label'] === 'string' ? o['label'] : '',
          description: typeof o['description'] === 'string' ? o['description'] : undefined,
        }))
      : undefined,
    multiSelect: q['multiSelect'] === true,
  }));
}

/** 扁平编号渲染：跨题连续编号（题1 选项 1..n，题2 选项 n+1..m）——与 parseNumericReply 同源 */
export function renderAskText(questions: AskQuestionView[]): string {
  const blocks: string[] = [];
  let n = 0;
  for (const q of questions) {
    if (!q.question) continue;
    const lines: string[] = [`❓ ${q.question}`];
    for (const o of q.options ?? []) {
      n += 1;
      lines.push(`${n}. ${o.label}${o.description ? `（${o.description}）` : ''}${q.multiSelect ? '（可多选）' : ''}`);
    }
    blocks.push(lines.join('\n'));
  }
  const multi = questions.some((q) => q.multiSelect);
  const footer = multi
    ? '（回复数字选择；多选用逗号分隔，如 1,3；也可以直接回复文字）'
    : '（回复数字选择，也可以直接回复文字）';
  return [...blocks, footer].join('\n\n');
}

export type AskReplyParse =
  | { kind: 'options'; answers: Record<string, string> }
  | { kind: 'free_text' }
  | { kind: 'invalid_numeric' };

/** 数字回复解析：`1` / `1,3`（半/全角逗号、顿号、空白容忍）。扁平编号确定性分配到所属题；
 * 单选题多项、越界、空文本 ⇒ invalid_numeric；非数字文本 ⇒ free_text；
 * 部分作答允许（未提及的题不入 answers——AskUserQuestion 缺键＝未作答，agent 补问）。 */
export function parseNumericReply(text: string, questions: AskQuestionView[]): AskReplyParse {
  const trimmed = (text ?? '').trim();
  if (trimmed === '') return { kind: 'invalid_numeric' };
  if (!/^[\d,，、\s]+$/.test(trimmed)) return { kind: 'free_text' };
  const nums = [...new Set(trimmed.split(/[,，、\s]+/).filter(Boolean).map((t) => Number.parseInt(t, 10)))].sort((a, b) => a - b);
  // 扁平编号 → {题, 选项} 映射（与 renderAskText 同序生成）
  const flat: Array<{ q: AskQuestionView; optLabel: string }> = [];
  for (const q of questions) for (const o of q.options ?? []) flat.push({ q, optLabel: o.label });
  const picksByQuestion = new Map<AskQuestionView, string[]>();
  for (const n of nums) {
    if (!Number.isInteger(n) || n < 1 || n > flat.length) return { kind: 'invalid_numeric' };
    const hit = flat[n - 1]!;
    picksByQuestion.set(hit.q, [...(picksByQuestion.get(hit.q) ?? []), hit.optLabel]);
  }
  for (const [q, picks] of picksByQuestion) {
    if (q.multiSelect !== true && picks.length > 1) return { kind: 'invalid_numeric' };
  }
  const answers: Record<string, string> = {};
  for (const [q, picks] of picksByQuestion) {
    if (q.question) answers[q.question] = picks.join(', ');
  }
  return { kind: 'options', answers };
}

export function buildContextPreamble(m: { userId: string; chatKey: string; chatType: InboundTextMessage['chatType'] }): string {
  const chatName = m.chatType === 'single' ? m.userId : m.chatKey.slice('group:'.length);
  const kind = m.chatType === 'single' ? 'p2p' : 'group';
  return `[Context: sender=${m.userId}, userid=${m.userId}, chat=${chatName} (${kind})]\n\n`;
}

export function buildQueuedBatchPrompt(messages: string[]): string {
  if (messages.length <= 1) return messages[0] ?? '';
  const items = messages.map((m, i) => `【消息 ${i + 1}】\n${m}`).join('\n\n');
  return `用户在上一条任务处理期间，先后发来了 ${messages.length} 条排队消息（按时间顺序排列，后发的消息可能修正或取消先发的）。请按对话语义依次理解并处理：\n\n${items}`;
}

/** 字节安全截断：Buffer 视图上回退到 UTF-8 序列边界，预留标记字节数。O(n)。 */
export function truncateUtf8(text: string, maxBytes: number, marker = '…[截断]'): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  let end = Math.max(0, maxBytes - markerBytes);
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1; // 跳过续字节，落在首字节
  return buf.subarray(0, end).toString('utf8') + marker;
}
```

- [x] **Step 4: 跑测确认 PASS** — Run: `bun run typecheck && bun test tests/unit tests/integration`
  Expected: PASS
- [x] **Step 5: Commit** — `git add src/agent/parser.ts tests/unit/parser.test.ts && git commit -m "feat(agent): pure stream-json/ask/numeric-reply/utf8-truncation parser"`

---

### Task 4: `src/agent/session-store.ts`（会话存储 + 惰性 TTL）

**Files:**
- Create: `src/agent/session-store.ts`
- Test: `tests/unit/session-store.test.ts`

**Interfaces:**
- Consumes: 无（仅 node:fs/node:path）
- Produces:
  - `interface ChatSession { chatKey: string; chatType: 'single' | 'group'; claudeSessionId: string | null; createdAt: string; lastActiveAt: string; status: 'active' | 'closed' }`
  - `class SessionStore { constructor(sessionsDir: string, opts?: { now?: () => Date }); resumable(chatKey: string, chatType: 'single' | 'group', ttlMs: number): ChatSession; get(chatKey): ChatSession | null; create(chatKey, chatType): ChatSession; setClaudeSessionId(chatKey, id: string): void; updateActivity(chatKey): void; close(chatKey): void; isStale(chatKey, ttlMs): boolean }`
  - `chatKeyOf(m: { chatType: 'single' | 'group'; chatId?: string; userId: string }): string`（`single:<userid>` / `group:<chatid>`；群聊缺 chatId 抛 Error——调用方已在上游过滤）

- [x] **Step 1: 写失败测试**（`tests/unit/session-store.test.ts`）

```ts
import { test, expect } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore, chatKeyOf } from '../../src/agent/session-store';

function makeStore(ttlMs = 60_000) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-sess-'));
  let now = 1_000_000;
  const store = new SessionStore(join(dir, 'sessions'), { now: () => new Date(now) });
  return { dir, store, advance: (ms: number) => { now += ms; } };
}

test('chatKeyOf：单聊/群聊键形；群聊缺 chatId 抛错', () => {
  expect(chatKeyOf({ chatType: 'single', userId: 'u1' })).toBe('single:u1');
  expect(chatKeyOf({ chatType: 'group', chatId: 'wr1', userId: 'u1' })).toBe('group:wr1');
  expect(() => chatKeyOf({ chatType: 'group', userId: 'u1' })).toThrow(/chatId/);
});

test('resumable：首建 → TTL 内同键同档可续；超 TTL 换新档', () => {
  const { store, advance } = makeStore(60_000);
  const s1 = store.resumable('single:u1', 'single', 60_000);
  expect(s1.claudeSessionId).toBeNull();
  store.setClaudeSessionId('single:u1', 'sid-1');
  store.updateActivity('single:u1');
  advance(30_000);
  const s2 = store.resumable('single:u1', 'single', 60_000);
  expect(s2.claudeSessionId).toBe('sid-1');   // TTL 内 resume 同档
  advance(31_000);                             // 累计超 TTL
  const s3 = store.resumable('single:u1', 'single', 60_000);
  expect(s3.claudeSessionId).toBeNull();       // 过期 ⇒ 新档
  expect(s3.createdAt).not.toBe(s1.createdAt);
});

test('落盘：base64url 文件名、0600 权限、原子写（无残 tmp）、内容含 chatKey', () => {
  const { dir, store } = makeStore();
  store.resumable('single:u1', 'single', 60_000);
  const files = readdirSync(join(dir, 'sessions'));
  expect(files).toEqual([Buffer.from('single:u1', 'utf8').toString('base64url') + '.json']);
  const full = join(dir, 'sessions', files[0]!);
  expect(statSync(full).mode & 0o077).toBe(0); // 0600
  expect(files.some((f) => f.includes('.tmp'))).toBe(false);
  expect((JSON.parse(readFileSync(full, 'utf8')) as { chatKey: string }).chatKey).toBe('single:u1');
});

test('坏档（非法 JSON）⇒ resumable 当作无会话新建，不抛', () => {
  const { dir } = makeStore();
  const f = Buffer.from('single:u1', 'utf8').toString('base64url') + '.json';
  writeFileSync(join(dir, 'sessions', f), '{broken');
  const store = new SessionStore(join(dir, 'sessions'));
  const s = store.resumable('single:u1', 'single', 60_000);
  expect(s.claudeSessionId).toBeNull();
});

test('close 后 get 返回 null（active 视图）；chatKey 超长拒绝（180 上限——base64url 编码后不超 NAME_MAX）', () => {
  const { store } = makeStore();
  store.resumable('single:u1', 'single', 60_000);
  store.close('single:u1');
  expect(store.get('single:u1')).toBeNull();
  store.resumable('x'.repeat(180), 'single', 60_000); // 180 ASCII 字节 = 边界内可建
  expect(() => store.resumable('x'.repeat(181), 'single', 60_000)).toThrow(/chatKey/);
  expect(() => store.resumable('汉'.repeat(61), 'single', 60_000)).toThrow(/chatKey/); // 61 CJK 字 = 183 字节 > 180（按字节计，非字符）
});
```

- [x] **Step 2: 跑测确认 FAIL** — Run: `bun test tests/unit/session-store.test.ts`
  Expected: FAIL（模块不存在）
- [x] **Step 3: 实现 `src/agent/session-store.ts`**

```ts
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface ChatSession {
  chatKey: string;
  chatType: 'single' | 'group';
  claudeSessionId: string | null;
  createdAt: string;
  lastActiveAt: string;
  status: 'active' | 'closed';
}

const MAX_KEY_BYTES = 160; // 执行修正（r1）：预算须按**原子写临时文件名**算——base64url(160B)=216 + '.json'=5 + tmp 后缀 17 = 238 < NAME_MAX(255)；180 会在 tmp 写入时 ENAMETOOLONG（测试实测）

export function chatKeyOf(m: { chatType: 'single' | 'group'; chatId?: string; userId: string }): string {
  if (m.chatType === 'group') {
    if (!m.chatId) throw new Error(`group chat requires chatId (userId=${m.userId})`);
    return `group:${m.chatId}`;
  }
  return `single:${m.userId}`;
}

/** 每 chat 会话档：base64url 文件名（不做 id 字符集假设）、原子写、0600。
 *  单写者由 W1 单网关契约（pidfile）保证。 */
export class SessionStore {
  constructor(private sessionsDir: string, private opts: { now?: () => Date } = {}) {
    mkdirSync(sessionsDir, { recursive: true });
  }

  private now(): Date { return this.opts.now ? this.opts.now() : new Date(); }

  private pathOf(chatKey: string): string {
    return join(this.sessionsDir, Buffer.from(chatKey, 'utf8').toString('base64url') + '.json');
  }

  get(chatKey: string): ChatSession | null {
    const keyBytes = Buffer.byteLength(chatKey, 'utf8');
    if (keyBytes > MAX_KEY_BYTES || keyBytes === 0) return null;
    let raw: string;
    try {
      raw = readFileSync(this.pathOf(chatKey), 'utf8');
    } catch {
      return null; // 无档（ENOENT）或不可读——一律视作无会话，调用方新建
    }
    try {
      const s = JSON.parse(raw) as ChatSession;
      if (!s || typeof s !== 'object' || s.chatKey !== chatKey) return null;
      if (s.status === 'closed') return null;
      return s;
    } catch {
      return null; // 坏档 ⇒ 当作无会话（严格丢，不修复）
    }
  }

  create(chatKey: string, chatType: 'single' | 'group'): ChatSession {
    const kb = Buffer.byteLength(chatKey, 'utf8');
    if (kb === 0 || kb > MAX_KEY_BYTES) {
      throw new Error(`invalid chatKey utf8 byte length: ${kb}`);
    }
    const now = this.now().toISOString();
    const s: ChatSession = { chatKey, chatType, claudeSessionId: null, createdAt: now, lastActiveAt: now, status: 'active' };
    this.write(s);
    return s;
  }

  /** 惰性 TTL 入口：active 且未过期 ⇒ 返回原档；否则（无档/过期/坏档）闭旧建新。 */
  resumable(chatKey: string, chatType: 'single' | 'group', ttlMs: number): ChatSession {
    const cur = this.get(chatKey);
    if (cur && !this.isStale(chatKey, ttlMs)) {
      this.updateActivity(chatKey);
      return cur;
    }
    if (cur) this.close(chatKey);
    return this.create(chatKey, chatType);
  }

  setClaudeSessionId(chatKey: string, id: string): void {
    const s = this.get(chatKey);
    if (!s) return;
    s.claudeSessionId = id;
    this.write(s);
  }

  updateActivity(chatKey: string): void {
    const s = this.get(chatKey);
    if (!s) return;
    s.lastActiveAt = this.now().toISOString();
    this.write(s);
  }

  isStale(chatKey: string, ttlMs: number): boolean {
    const s = this.get(chatKey);
    if (!s) return true;
    const t = Date.parse(s.lastActiveAt);
    if (!Number.isFinite(t)) return true;
    return this.now().getTime() - t > ttlMs;
  }

  close(chatKey: string): void {
    const s = this.get(chatKey);
    if (!s) return;
    this.write({ ...s, status: 'closed' });
  }

  private write(s: ChatSession): void {
    const final = this.pathOf(s.chatKey);
    const tmp = `${final}.${randomBytes(6).toString('hex')}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, final);
  }
}
```

- [x] **Step 4: 跑测确认 PASS** — Run: `bun run typecheck && bun test tests/unit tests/integration`
  Expected: PASS
- [x] **Step 5: Commit** — `git add src/agent/session-store.ts tests/unit/session-store.test.ts && git commit -m "feat(agent): per-chat session store with lazy TTL, base64url names, atomic 0600 writes"`

---

### **Checkpoint A**（Task 4 后）

- [ ] Run: `bun run typecheck && bun test tests/unit tests/integration && bun run build && bash scripts/check-dist.sh && bun run smoke`
- [ ] 确认：全绿；`git log --oneline` 四个 W2 提交在 issue 分支；无 `.bot/` 泄漏进 git（`git status` 干净）。

---

### Task 5: fake claude 测试基础设施

**Files:**
- Create: `tests/helpers/fake-claude.mjs`（**纯 node 脚本**，被 spawn 为子进程——不得 import bun:test）
- Create: `tests/helpers/fake-claude-scenarios.md` 不需要——场景即代码内 switch。

**Interfaces:**
- Produces: 环境变量驱动的 fake claude：
  - `FAKE_CLAUDE_STATE_DIR`（必填）：追加写 `argv.jsonl`（每行 `{argv, cwd, hasClaudecode}`）、`stdin.jsonl`（每行一条收到的 stdin JSON 原文）、`sessions.jsonl`（每行本进程 emit 的 session_id）。
  - `FAKE_CLAUDE_SCENARIO`（必填）∈ `happy` | `ask` | `ask-multi` | `no-output` | `resume-not-found` | `crash` | `garbage` | `deltas` | `ignore-signals` | `slow-output`（`FAKE_CLAUDE_DELAY_MS` 可调延迟）。状态目录另追加 `exit.jsonl`（pid+ts 生命周期记录，供「旧进程退出先于新 spawn」断言）。
  - 供测试注入的 command：`{ command: process.execPath, argsPrefix: ['<abs>/tests/helpers/fake-claude.mjs'] }`。

- [ ] **Step 1: 写 `tests/helpers/fake-claude.mjs`**

```js
#!/usr/bin/env node
// fake claude：按 FAKE_CLAUDE_SCENARIO 回放 stream-json。协议与真实 claude --print
// --input-format stream-json --output-format stream-json 一致（feishubot 生产实核）。
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

const SCENARIO = process.env.FAKE_CLAUDE_SCENARIO ?? 'happy';
const DIR = process.env.FAKE_CLAUDE_STATE_DIR;
if (!DIR) { process.stderr.write('FAKE_CLAUDE_STATE_DIR required\n'); process.exit(2); }

const argv = process.argv.slice(2); // argsPrefix 之后的全部参数（即 claude 的参数）
const resumeIdx = argv.indexOf('--resume');
const resumeId = resumeIdx >= 0 ? argv[resumeIdx + 1] : null;
appendFileSync(join(DIR, 'argv.jsonl'), JSON.stringify({
  argv, cwd: process.cwd(), hasClaudecode: 'CLAUDECODE' in process.env, resumeId,
  pid: process.pid, ts: Date.now(),
}) + '\n');
process.on('exit', () => {
  appendFileSync(join(DIR, 'exit.jsonl'), JSON.stringify({ pid: process.pid, ts: Date.now() }) + '\n');
});

const sessionId = resumeId ?? `fake-sid-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const logStdin = (line) => appendFileSync(join(DIR, 'stdin.jsonl'), line + '\n');

function emitInit() {
  appendFileSync(join(DIR, 'sessions.jsonl'), sessionId + '\n');
  out({ type: 'system', subtype: 'init', session_id: sessionId });
}
const assistant = (text) => out({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', content: [{ type: 'text', text }] } });
const result = (extra = {}) => out({ type: 'result', subtype: 'success', result: 'done', session_id: sessionId, ...extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readUserLine() {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    logStdin(line);
    try {
      const obj = JSON.parse(line);
      if (obj?.type === 'user') return obj;
      if (obj?.type === 'control_response') return obj; // ask 场景的作答回路
    } catch { /* 忽略坏行（garbage 容错与真实 CLI 一致性不要求） */ }
  }
  return null;
}

const ASK_INPUT = {
  questions: [
    { question: '选哪个方案？', options: [{ label: '甲' }, { label: '乙' }] },
  ],
};
const ASK_MULTI_INPUT = {
  questions: [
    { question: '用哪个库？', options: [{ label: 'bun' }, { label: 'node' }] },
    { question: '要不要日志？', options: [{ label: '要' }, { label: '不要' }], multiSelect: true },
  ],
};

switch (SCENARIO) {
  case 'happy': {
    await readUserLine();
    emitInit();
    assistant('这是假回复：处理完成。');
    result();
    break;
  }
  case 'deltas': {
    await readUserLine();
    emitInit();
    assistant('第一段。');
    assistant('第二段。');
    assistant('第三段。');
    result();
    break;
  }
  case 'ask':
  case 'ask-multi': {
    await readUserLine();
    emitInit();
    assistant('先确认一下：');
    out({
      type: 'control_request', request_id: 'cr-1',
      request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: SCENARIO === 'ask' ? ASK_INPUT : ASK_MULTI_INPUT },
    });
    const resp = await readUserLine(); // 等作答（control_response）
    if (resp?.type !== 'control_response') { process.exit(1); }
    assistant(`已收到选择，继续执行（request_id=${resp.response?.request_id ?? '?'}）。`);
    result();
    break;
  }
  case 'no-output': {
    emitInit();
    await sleep(120_000); // 永不产出——等被杀（超时护栏测试用压缩 turnTimeoutMs）
    process.exit(9);
    break;
  }
  case 'resume-not-found': {
    if (resumeId) {
      emitInit();
      out({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['No conversation found'], session_id: sessionId });
    } else {
      await readUserLine();
      emitInit();
      assistant('新会话回复。');
      result();
    }
    break;
  }
  case 'crash': {
    process.stderr.write('fake claude crashed\n');
    process.exit(1);
    break;
  }
  case 'slow-output': {
    // 晚输出对抗样本：延迟 FAKE_CLAUDE_DELAY_MS 后才产出（默认 500ms）——
    // 配压缩 turnTimeoutMs 验证“deadline 先到 ⇒ 杀 + turn_failed(timeout)，无迟到流活动”
    await readUserLine();
    emitInit();
    await sleep(Number.parseInt(process.env.FAKE_CLAUDE_DELAY_MS ?? '500', 10));
    assistant('迟到的输出。');
    result();
    break;
  }
  case 'ignore-signals': {
    // 超时护栏的对抗样本：忽略 SIGINT/SIGTERM——验证收割梯子升级到 SIGKILL
    process.on('SIGINT', () => process.stderr.write('ignored SIGINT\n'));
    process.on('SIGTERM', () => process.stderr.write('ignored SIGTERM\n'));
    emitInit();
    await sleep(120_000);
    process.exit(9);
    break;
  }
  case 'garbage': {
    emitInit();
    process.stdout.write('not-json\n');
    process.stdout.write('{"type":"weird"}\n');
    process.exit(0); // EOF 且无终态事件
    break;
  }
  default: {
    process.stderr.write(`unknown scenario ${SCENARIO}\n`);
    process.exit(2);
  }
}
```

- [ ] **Step 2: 冒烟验证（不写正式测试——Task 6 的用例即验证）** — Run:
  `mkdir -p /tmp/fc && FAKE_CLAUDE_STATE_DIR=/tmp/fc FAKE_CLAUDE_SCENARIO=happy bash -c 'echo "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"hi\"}}" | node tests/helpers/fake-claude.mjs --print --model glm-5.3-flash'`
  Expected: stdout 三行 NDJSON（system/assistant/result）；`/tmp/fc/argv.jsonl` 记录 `--model glm-5.3-flash`、`resumeId: null`、`hasClaudecode: false`、`cwd` = 当前目录。
- [ ] **Step 3: Commit** — `git add tests/helpers/fake-claude.mjs && git commit -m "test(agent): fake claude child with scenario-driven stream-json playback"`

---

### Task 6: `src/agent/manager.ts`（spawn / 队列 / 收割 / pending ask / 绝对超时）

**Files:**
- Create: `src/agent/manager.ts`
- Test: `tests/unit/manager.test.ts`

**Interfaces:**
- Consumes: `SessionStore`（Task 4）、parser 全套（Task 3）、`BotLogger`（W1）。
- Produces:
  - `type AgentEvent = { type: 'text_delta'; chatKey: string; text: string } | { type: 'ask'; chatKey: string; questions: AskQuestionView[] } | { type: 'turn_complete'; chatKey: string; finalText: string } | { type: 'turn_failed'; chatKey: string; error: string } | { type: 'ask_expired'; chatKey: string }`
  - `interface ClaudeCommand { command: string; argsPrefix: string[] }`
  - `const TURN_TIMEOUT_ERROR = 'turn timeout exceeded'`（handler 据此映射超时文案）
  - `interface AgentManagerOptions { claudeCommand?: ClaudeCommand | (() => ClaudeCommand); idleTtlMs?: number; turnTimeoutMs?: number; maxConcurrentTurns?: number; perUserInFlight?: number; queueLimit?: number; model?: string; buildSystemPrompt?: (workspacePath: string) => string; reapEofMs?: number; reapTermMs?: number }`
  - `class AgentManager { constructor(deps: { workspacePath: string; sessions: SessionStore; logger: BotLogger; options?: AgentManagerOptions }); submit(chatKey: string, chatType: 'single' | 'group', userId: string, prompt: string, onEvent: (ev: AgentEvent) => void): 'started' | 'queued' | 'queue-full' | 'shutdown'; answerPendingAsk(chatKey: string, text: string): 'answered' | 'invalid_numeric' | 'none'; hasPendingAsk(chatKey: string): boolean; expireStaleAsk(chatKey: string): boolean; closeAll(): Promise<void>; isShuttingDown(): boolean }`

- [ ] **Step 1: 写失败测试**（`tests/unit/manager.test.ts`；fake claude 注入 + 压缩时序）

```ts
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
  process.env.FAKE_CLAUDE_STATE_DIR = stateDir; process.env.FAKE_CLAUDE_SCENARIO = scenario;
  const manager = new AgentManager({
    workspacePath: dir, sessions, logger,
    options: { claudeCommand: FAKE(), turnTimeoutMs: 5_000, idleTtlMs: 60_000, ...opts },
  });
  return { dir, stateDir, manager, sessions };
}

const flush = (ms = 400) => new Promise((r) => setTimeout(r, ms));
const argvLog = (stateDir: string) =>
  readFileSync(join(stateDir, 'argv.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { argv: string[]; resumeId: string | null; cwd: string; hasClaudecode: boolean });
const stdinLog = (stateDir: string) =>
  existsSync(join(stateDir, 'stdin.jsonl')) ? readFileSync(join(stateDir, 'stdin.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];

test('happy：spawn 参数完整（--print/stream-json/bypassPermissions/--model）、cwd=workspace、env 无 CLAUDECODE、stdin 收到 user 消息、事件序 text_delta→turn_complete', async () => {
  const { stateDir, manager } = makeManager('happy');
  const events: AgentEvent[] = [];
  const verdict = manager.submit('single:u1', 'single', 'u1', '[Context: sender=u1…]\n\n你好', (ev) => events.push(ev));
  expect(verdict).toBe('started');
  await flush();
  const [a] = argvLog(stateDir);
  expect(a.argv).toContain('--print');
  expect(a.argv).toContain('--output-format'); expect(a.argv).toContain('stream-json');
  expect(a.argv).toContain('--input-format'); expect(a.argv).toContain('stream-json');
  expect(a.argv).toContain('--permission-prompt-tool'); expect(a.argv).toContain('stdio');
  expect(a.argv).toContain('--permission-mode'); expect(a.argv).toContain('bypassPermissions');
  expect(a.argv.join(' ')).toContain('--model glm-5.3-flash');
  expect(a.argv.join(' ')).toContain('--append-system-prompt');
  expect(a.resumeId).toBeNull();
  expect(a.hasClaudecode).toBe(false);
  const [stdin1] = stdinLog(stateDir);
  expect(stdin1.type).toBe('user');
  expect(stdin1.message.content).toContain('你好');
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
  const [, a2] = argvLog(stateDir);
  expect(a2.argv).toContain('--resume');
  const sessions = readFileSync(join(stateDir, 'sessions.jsonl'), 'utf8').trim().split('\n');
  expect(a2.argv[a2.argv.indexOf('--resume') + 1]).toBe(sessions[0]);
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
  expect(stdins[1]!.message.content).toContain('2 条排队消息');
  expect(stdins[1]!.message.content).toContain('【消息 1】');
  expect(stdins[1]!.message.content).toContain('【消息 2】');
  await manager.closeAll();
});

test('ask：control_request 注册 pending；数字作答写回 control_response（answers 携带 label）；作答后回合继续至 complete', async () => {
  const { stateDir, manager } = makeManager('ask');
  const events: AgentEvent[] = [];
  manager.submit('single:u1', 'single', 'u1', '开始', (ev) => events.push(ev));
  await flush();
  expect(manager.hasPendingAsk('single:u1')).toBe(true);
  expect(events.some((e) => e.type === 'ask')).toBe(true);
  expect(manager.answerPendingAsk('single:u1', '2')).toBe('answered');
  await flush();
  const responses = stdinLog(stateDir).filter((l) => l.type === 'control_response');
  expect(responses.length).toBe(1);
  expect(responses[0]!.response.request_id).toBe('cr-1');
  expect(responses[0]!.response.response.behavior).toBe('allow');
  expect(responses[0]!.response.response.updatedInput.answers).toEqual({ '选哪个方案？': '乙' });
  expect(events.at(-1)!.type).toBe('turn_complete');
  expect(manager.hasPendingAsk('single:u1')).toBe(false);
  await manager.closeAll();
});

test('ask：多选 1,3 跨题分配；非数字 ⇒ 首题自由文本；越界 ⇒ invalid_numeric 且 pending 保持', async () => {
  const { manager } = makeManager('ask-multi');
  manager.submit('single:u1', 'single', 'u1', '开始', () => {});
  await flush();
  expect(manager.answerPendingAsk('single:u1', '1,3')).toBe('answered');
  await flush();
  await manager.closeAll();

  const m2 = makeManager('ask-multi');
  m2.manager.submit('single:u2', 'single', 'u2', '开始', () => {});
  await flush();
  expect(m2.manager.answerPendingAsk('single:u2', '直接用 bun')).toBe('answered');
  const free = stdinLog(m2.stateDir).filter((l: { type: string }) => l.type === 'control_response');
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
  manager.submit('single:u1', 'single', 'u1', '慢回合1', (ev) => ev1.push(ev));
  manager.submit('single:u2', 'single', 'u2', '慢回合2', (ev) => ev2.push(ev)); // 并发第二回合
  await flush(1_500);
  for (const evs of [ev1, ev2]) {
    const fail = evs.find((e) => e.type === 'turn_failed');
    expect(fail).toBeDefined();
    expect((fail as { error: string }).error).toContain(TURN_TIMEOUT_ERROR);
  }
  await manager.closeAll();
});

test('信号无视的子进程：收割梯子升级 SIGKILL，turn_failed 仍按期发出（deadline 语义按流段计）', async () => {
  const { manager } = makeManager('ignore-signals', { turnTimeoutMs: 300, reapEofMs: 200, reapTermMs: 200 });
  const events: AgentEvent[] = [];
  manager.submit('single:u1', 'single', 'u1', '顽固回合', (ev) => events.push(ev));
  await flush(4_000); // 300ms 超时 + 200ms EOF 宽限 + 200ms TERM 宽限 + KILL 沉降
  const fail = events.find((e) => e.type === 'turn_failed');
  expect(fail).toBeDefined();
  expect((fail as { error: string }).error).toContain(TURN_TIMEOUT_ERROR);
  await manager.closeAll();
});

test('过期 ask：收割完成后才放行后续回合（新 spawn 不与旧进程重叠）', async () => {
  const { stateDir, manager } = makeManager('ask', { idleTtlMs: 300, reapEofMs: 250, reapTermMs: 250 });
  const events: AgentEvent[] = [];
  manager.submit('single:u1', 'single', 'u1', '开始', (ev) => events.push(ev));
  await flush();
  expect(manager.hasPendingAsk('single:u1')).toBe(true);
  await new Promise((r) => setTimeout(r, 400)); // 会话 TTL 过期
  expect(manager.expireStaleAsk('single:u1')).toBe(true);
  const v = manager.submit('single:u1', 'single', 'u1', '新问题', (ev) => events.push(ev));
  expect(v).toBe('queued'); // 旧进程收割期间排队，不并行 spawn
  await flush(1_500);
  const argvs = argvLog(stateDir) as Array<{ pid: number; ts: number }>;
  expect(argvs.length).toBe(2); // 旧回合 + 收割完成后的新回合
  const exits = readFileSync(join(stateDir, 'exit.jsonl'), 'utf8').trim().split('\n')
    .map((l) => JSON.parse(l) as { pid: number; ts: number });
  const oldExit = exits.find((e) => e.pid === argvs[0]!.pid);
  expect(oldExit).toBeDefined();
  expect(oldExit!.ts).toBeLessThanOrEqual(argvs[1]!.ts); // 旧进程退出先于新 spawn（R2-F3 的可证形态）
  expect(events.filter((e) => e.type === 'ask').length).toBe(2); // 新回合正常起步（ask 场景再问一次）
  await manager.closeAll();
});

test('晚输出竞态：deadline 先于输出到达 ⇒ 杀 + turn_failed(timeout)，失败后无迟到流活动', async () => {
  process.env.FAKE_CLAUDE_DELAY_MS = '1500';
  const { manager } = makeManager('slow-output', { turnTimeoutMs: 300 });
  const events: AgentEvent[] = [];
  manager.submit('single:u1', 'single', 'u1', '慢输出', (ev) => events.push(ev));
  await flush(2_500); // deadline(300ms) 杀进程后，fake 的迟到输出不应再产生事件
  const fail = events.find((e) => e.type === 'turn_failed') as { error: string } | undefined;
  expect(fail).toBeDefined();
  expect(fail!.error).toContain(TURN_TIMEOUT_ERROR);
  const after = events.slice(events.indexOf(fail!));
  expect(after.every((e) => e.type !== 'text_delta' && e.type !== 'turn_complete')).toBe(true);
  await manager.closeAll();
  delete process.env.FAKE_CLAUDE_DELAY_MS;
});

test('群聊混合发送者批量回合：并发帽按全部发送者计（perUserInFlight=1 时两发送者都被占满）', async () => {
  const { stateDir, manager } = makeManager('happy', { perUserInFlight: 1, maxConcurrentTurns: 8 });
  manager.submit('group:g1', 'group', 'u1', '甲的消息', () => {});           // u1 占 group:g1
  expect(manager.submit('group:g1', 'group', 'u2', '乙的排队消息', () => {})).toBe('queued'); // busy ⇒ 排队
  await flush(900); // 批量回合跑起（initiators=[u1,u2]）
  expect(manager.submit('single:u1', 'single', 'u1', 'u1 再来', () => {})).toBe('queued'); // u1 被批量回合占用
  expect(manager.submit('single:u2', 'single', 'u2', 'u2 再来', () => {})).toBe('queued'); // u2 同样被占用（R3-F2）
  expect(manager.submit('single:u3', 'single', 'u3', 'u3 不受影响', () => {})).toBe('started');
  await manager.closeAll();
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
  manager.submit('single:u1', 'single', 'u1', 'x', (ev) => events.push(ev));
  await flush(600);
  const fail = events.find((e) => e.type === 'turn_failed') as { error: string } | undefined;
  expect(fail).toBeDefined();
  expect(fail!.error).toMatch(/spawn|ENOENT/i);
  await manager.closeAll();
});

test('resume 失败：No conversation found ⇒ 恰好一次 fresh 重试（第二条 argv 无 --resume，回合最终 complete）', async () => {
  const { stateDir, manager } = makeManager('resume-not-found');
  const events: AgentEvent[] = [];
  manager.submit('single:u1', 'single', 'u1', '第一回合', () => {}); // fake: happy-like（无 resumeId ⇒ 正常）
  await flush();
  manager.submit('single:u1', 'single', 'u1', '第二回合', (ev) => events.push(ev)); // fake: --resume 在场 ⇒ 报错 → 重试
  await flush(900);
  const logs = argvLog(stateDir);
  expect(logs.length).toBe(3); // turn1 + turn2(resume) + turn2-retry(fresh)
  expect(logs[2]!.resumeId).toBeNull();
  expect(events.at(-1)!.type).toBe('turn_complete');
  await manager.closeAll();
});

test('崩溃与垃圾输出：crash ⇒ turn_failed(stderr 摘要)；garbage(EOF 无终态且 exit 0) 也 ⇒ turn_failed（不留孤儿流）', async () => {
  const m1 = makeManager('crash');
  const ev1: AgentEvent[] = [];
  m1.manager.submit('single:c1', 'single', 'c1', 'x', (ev) => ev1.push(ev));
  await flush();
  expect(ev1.at(-1)!.type).toBe('turn_failed');
  await m1.manager.closeAll();

  const m2 = makeManager('garbage');
  const ev2: AgentEvent[] = [];
  m2.manager.submit('single:c2', 'single', 'c2', 'x', (ev) => ev2.push(ev));
  await flush();
  expect(ev2.at(-1)!.type).toBe('turn_failed');
  await m2.manager.closeAll();
});

test('并发帽：全局 maxConcurrentTurns=1 时第二个 chat 的消息排队，第一个回合结束后才获准运行（跨 chat 提升）', async () => {
  const { stateDir, manager } = makeManager('happy', { maxConcurrentTurns: 1 });
  const evA: AgentEvent[] = [];
  manager.submit('single:a', 'single', 'a', 'x', (ev) => evA.push(ev));
  const v = manager.submit('single:b', 'single', 'b', 'y', () => {});
  expect(v).toBe('queued');
  await flush(900); // a 回合收尾后调度器唤醒排队中的 b（跨 chat promote）
  const stdins = stdinLog(stateDir);
  expect(stdins.length).toBe(2);
  expect(stdins[0]!.message.content).toContain('x');
  expect(stdins[1]!.message.content).toContain('y');
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
```

- [ ] **Step 2: 跑测确认 FAIL** — Run: `bun test tests/unit/manager.test.ts`
  Expected: FAIL（模块不存在）
- [ ] **Step 3: 实现 `src/agent/manager.ts`**

```ts
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
  /** 本回合计入并发帽的全部用户（群聊批量回合按全部发送者计——R2-F8） */
  initiators: string[];
  deadline: NodeJS.Timeout | null;
  /** 过期 ask 收割中：槽位保留至收割完成（R2-F3——先释放会让新旧子进程重叠） */
  terminating: boolean;
}

/** 有界收割梯子（feishubot 实核：claude --print 等 stdin EOF——不收即每回合泄漏进程） */
const activeTerminations = new WeakMap<ChildProcess, Promise<void>>();
const timedOutProcs = new WeakSet<ChildProcess>();       // 超时击杀哨兵（runTurn 据此发 TURN_TIMEOUT_ERROR）
const resumeNotFoundProcs = new WeakSet<ChildProcess>(); // resume 失败重试哨兵（恰好一次）

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
      model: o.model ?? 'glm-5.3-flash',
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
    const turn = this.busy.get(chatKey);
    if (turn?.proc === entry.proc) {
      if (turn.deadline) clearTimeout(turn.deadline);
      turn.terminating = true; // 槽位保留到收割完成——紧随的新 submit 会排队（R2-F3）
      try { turn.proc.kill('SIGINT'); } catch { /* 已退 */ }
      void terminateChild(turn.proc, this.opts.reapEofMs, this.opts.reapTermMs)
        .then(() => {
          if (this.busy.get(chatKey) === turn) this.busy.delete(chatKey);
          this.scheduleAfterRelease(chatKey);
        });
    }
    this.deps.logger.warn('pending ask expired with session ttl', { chatKey });
    return true;
  }

  submit(chatKey: string, chatType: 'single' | 'group', userId: string, prompt: string, onEvent: AgentEventHandler): 'started' | 'queued' | 'queue-full' | 'shutdown' {
    if (this.shuttingDown) return 'shutdown';
    if (!this.canStart(chatKey, [userId])) {
      const q = this.queues.get(chatKey) ?? [];
      if (q.length >= this.opts.queueLimit) return 'queue-full';
      q.push({ prompt, userId, onEvent });
      this.queues.set(chatKey, q);
      this.deps.sessions.updateActivity(chatKey); // 排队也是活动——TTL 不得在等待期吞掉会话
      return 'queued';
    }
    void this.runTurn(chatKey, chatType, [userId], prompt, onEvent, false);
    return 'started';
  }

  /** 数字/自由文本作答：写 control_response 回仍在运行的进程。
   *  作答者（群内可为非发起人——D2）计入本回合 initiators（R3-F2：并发帽不可漏计影响者）。 */
  answerPendingAsk(chatKey: string, text: string, answeringUserId?: string): 'answered' | 'invalid_numeric' | 'none' {
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
    this.pendingAsks.delete(chatKey);
    this.deps.sessions.updateActivity(chatKey);
    const turn = this.busy.get(chatKey);
    if (turn?.proc === entry.proc && answeringUserId && !turn.initiators.includes(answeringUserId)) {
      turn.initiators.push(answeringUserId); // 群内作答者与回合并发相关——计入帽（R3-F2）
    }
    entry.proc.stdin.write(JSON.stringify({
      type: 'control_response',
      response: { subtype: 'success', request_id: entry.requestId, response: { behavior: 'allow', updatedInput: { ...entry.input, answers } } },
    }) + '\n');
    // 答复后重开整段流预算：ask 已闭旧流，后续输出走新流（D7——deadline 按"流段"计）
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

  /** 每回合（busy 记录）独立 deadline——并发回合互不清除（plan 评审 F2）。
   *  预算按流段计（R2-F2）：ask 闭流时 clear（等待期不计时），作答后续段重臂整段预算。 */
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
    const session = this.deps.sessions.resumable(chatKey, chatType, this.opts.idleTtlMs);
    const resumeId = freshRetry ? null : session.claudeSessionId;
    const claude = this.claudeSpawn();
    const proc = spawn(claude.command, [...claude.argsPrefix, ...this.buildArgs(resumeId)], {
      cwd: this.deps.workspacePath,
      env: this.buildEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.busy.set(chatKey, { proc, initiators: [...new Set(userIds)], deadline: null, terminating: false });
    this.armDeadline(chatKey, proc);
    this.deps.logger.info('turn starting', { chatKey, resume: resumeId ?? '(fresh)', pid: proc.pid });

    let stderrBuf = '';
    proc.stderr?.on('data', (c: Buffer) => { stderrBuf += c.toString(); });
    let spawnError = ''; // ENOENT 等 spawn 期失败（无 exit 跟随）
    proc.on('error', (err: Error & { code?: string }) => { spawnError = err.message; });
    let fullText = '';
    let turnFinished = false;

    try {
      proc.stdin?.write(JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n');
    } catch (e) {
      this.deps.logger.error('stdin write failed at turn start', { chatKey, err: (e as Error).message });
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
            await onEvent({ type: 'ask', chatKey, questions }); // 闭流帧发完才继续读（背压，F9）
          } else {
            proc.stdin?.write(JSON.stringify({
              type: 'control_response',
              response: { subtype: 'success', request_id: c.requestId, response: { behavior: 'allow', updatedInput: c.input ?? {} } },
            }) + '\n');
          }
          continue;
        }
        if (event.type === 'control_cancel_request') {
          if (this.pendingAsks.get(chatKey)?.proc === proc) {
            this.pendingAsks.delete(chatKey);
            this.armDeadline(chatKey, proc);
          }
          continue;
        }
        if (event.type === 'assistant') {
          const text = extractTextFromAssistant(event);
          if (text) {
            fullText += text;
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
            resumeNotFoundProcs.add(proc);
            await onEvent({ type: 'text_delta', chatKey, text: '⚠️ 会话恢复失败，正在重新开始对话…\n\n' });
            break;
          }
          turnFinished = true;
          if (isError) {
            await onEvent({ type: 'turn_failed', chatKey, error: errors.join('; ') || resultText || `claude result error (${String(event.subtype)})` });
          } else {
            // turn_input_required 亦按完成收（bypass+stdio 下不应出现；出现即回合已终）
            await onEvent({ type: 'turn_complete', chatKey, finalText: fullText });
          }
          break;
        }
        if (event.type === 'error') {
          turnFinished = true;
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
      if (timedOutProcs.has(proc)) {
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
    if (this.pendingAsks.get(chatKey)?.proc === proc) this.pendingAsks.delete(chatKey);
    if (this.busy.get(chatKey)?.proc === proc) this.busy.delete(chatKey);
    // 收割完成才放行槽位/排 drain（plan 评审 F10：有界等待，~3.3s 上限）
    await terminateChild(proc, this.opts.reapEofMs, this.opts.reapTermMs);

    if (!this.shuttingDown && resumeNotFoundProcs.has(proc)) {
      void this.runTurn(chatKey, chatType, userIds, prompt, onEvent, true); // resume 失败重试（恰好一次）——沿用当代 initiators
      return;
    }
    this.scheduleAfterRelease(chatKey);
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
    for (const t of turns) if (t.deadline) clearTimeout(t.deadline);
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
```

（实现纪律：① `submit` 的 `onEvent` 类型为 `AgentEventHandler`（可返回 Promise）——manager 对终态事件 `await`（终帧落定才放行下一回合）、对 text_delta `void`；② `scheduleAfterRelease` 的批量回采用**最新**排队消息的 onEvent（其闭包绑最新 replyTo——WeCom 回执句柄以最新回调最可能仍有效；与 feishubot F1「首条上下文」不同，属平台差异的显式选择，PR 描述须提及）；③ 每 chat 队列因全局/用户帽排队时，靠 `scheduleAfterRelease` 的跨 chat FIFO 提升唤醒——没有它排队 chat 会饿死（plan 评审 F1）。）
- [ ] **Step 4: 跑测确认 PASS** — Run: `bun run typecheck && bun test tests/unit tests/integration`
  Expected: PASS（fake claude 子进程真实 spawn/收割被验证）
- [ ] **Step 5: Commit** — `git add src/agent/manager.ts tests/unit/manager.test.ts && git commit -m "feat(agent): spawn/resume/queue/reap manager with absolute turn timeout and pending asks"`

---

### Task 7: `src/handlers/agent.ts`（流桥 + 限流）+ Gateway 接线 + 删 EchoHandler

**Files:**
- Create: `src/handlers/agent.ts`
- Modify: `src/gateway.ts:10-44`（BotHandler 注入 + stop 链）
- Modify: `src/commands/run.ts` / `src/commands/start.ts`（仅当构造签名变化波及——createGateway 内聚，CLI 不动）
- Delete: `src/handlers/echo.ts`、`tests/integration/echo.test.ts`
- Modify: `tests/unit/gateway-fatal.test.ts`（handler 注入重写第二个用例）
- Test: `tests/unit/agent-handler.test.ts`（新增）

**Interfaces:**
- Consumes: `AgentManager`（Task 6）、parser（Task 3）、`WeComTransport.replyStream`（W1）、`chatKeyOf`（Task 4）。
- Produces:
  - `interface AgentManagerPort { submit(chatKey, chatType, userId, prompt, onEvent): string; answerPendingAsk(chatKey, text, answeringUserId?): 'answered'|'invalid_numeric'|'none'; hasPendingAsk(chatKey): boolean; expireStaleAsk(chatKey): boolean; closeAll(): Promise<void> }`（AgentManager 结构兼容）
  - `class ConversationRateLimiter { constructor(opts?: { perMinute?: number; perHour?: number; now?: () => number }); tryAcquire(key: string): boolean; record(key: string): void }`（record = 逃逸记账——R3-F1 契约面）
  - `interface AgentHandlerOptions { onReplyError?: (err: Error) => void; refreshIntervalMs?: number; maxContentBytes?: number }`
  - `class AgentHandler implements BotHandler { constructor(deps: { transport: WeComTransport; logger: BotLogger; manager: AgentManagerPort; workspace: string }, opts?: AgentHandlerOptions); register(): void; stop(): Promise<void> }`
  - `interface BotHandler { register(): void; stop?(): Promise<void> }`（`src/gateway.ts` 导出）
  - `createGateway(workspace, transportOverrides?, agentOverrides?: { claudeCommand?; idleTtlMs?; turnTimeoutMs?; refreshIntervalMs?; maxConcurrentTurns? })`

- [ ] **Step 1: 写失败测试**

  `tests/unit/agent-handler.test.ts`：

```ts
import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentHandler, ConversationRateLimiter } from '../../src/handlers/agent';
import type { AgentEvent } from '../../src/agent/manager';
import type { InboundTextMessage, ReplyRef, WeComTransport } from '../../src/transport/types';
import { BotLogger } from '../../src/logger';

class FakeTransport implements WeComTransport {
  sent: Array<{ streamId: string; content: string; finish: boolean }> = [];
  replyImpl: (content: string, finish: boolean) => Promise<void> = async () => undefined;
  private handlers: Array<(e: unknown) => void> = [];
  async start() {} async stop() {} isConnected() { return true; }
  on(h: (e: unknown) => void) { this.handlers.push(h); }
  emit(e: unknown) { for (const h of this.handlers) h(e); }
  async replyStream(_ref: ReplyRef, streamId: string, content: string, finish: boolean) {
    this.sent.push({ streamId, content, finish });
    await this.replyImpl(content, finish);
  }
}

class FakeManager {
  submitted: Array<{ chatKey: string; prompt: string }> = [];
  answers: string[] = [];
  answerResult: 'answered' | 'invalid_numeric' | 'none' = 'answered';
  submitResult: 'started' | 'queued' | 'queue-full' | 'shutdown' = 'started';
  pendingFlag = false;
  nextEvents: Array<(emit: (ev: AgentEvent) => void) => void> = [];
  submit(chatKey: string, _ct: 'single' | 'group', _u: string, prompt: string, onEvent: (ev: AgentEvent) => void) {
    this.submitted.push({ chatKey, prompt });
    const gen = this.nextEvents.shift();
    if (gen) queueMicrotask(() => gen(onEvent));
    return this.submitResult;
  }
  answerPendingAsk(_k: string, text: string) { this.answers.push(text); return this.answerResult; }
  hasPendingAsk() { return this.pendingFlag; }
  expireStaleAsk() { return false; }
  async closeAll() {}
}

function makeHandler(manager = new FakeManager(), opts: { onReplyError?: (e: Error) => void } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-hdl-'));
  mkdirSync(join(dir, 'logs'), { recursive: true });
  const transport = new FakeTransport();
  const logger = new BotLogger({ level: 'debug', logDir: join(dir, 'logs'), console: false });
  const handler = new AgentHandler({ transport, logger, manager, workspace: dir }, { refreshIntervalMs: 10, ...opts });
  return { handler, transport, manager, dir, logger };
}

const MSG = (over: Partial<InboundTextMessage> = {}): { type: 'textMessage'; message: InboundTextMessage } => ({
  type: 'textMessage',
  message: { msgid: 'm1', chatType: 'single', userId: 'u1', content: 'hi', replyTo: { __brand: 'ReplyRef', reqId: 'r1' }, ...over },
});
const flush = (ms = 50) => new Promise((r) => setTimeout(r, ms));

test('AC1 桥：text_delta 节流刷新（同 stream.id、finish=false）→ turn_complete 终帧 finish=true', async () => {
  const { handler, transport, manager } = makeHandler();
  handler.register();
  manager.nextEvents.push((emit) => {
    emit({ type: 'text_delta', chatKey: 'single:u1', text: '第一段' });
    emit({ type: 'text_delta', chatKey: 'single:u1', text: '第二段' });
    emit({ type: 'turn_complete', chatKey: 'single:u1', finalText: '第一段第二段' });
  });
  transport.emit(MSG());
  await flush();
  const ids = new Set(transport.sent.map((f) => f.streamId));
  expect(ids.size).toBe(1);
  expect(transport.sent.at(-1)!.finish).toBe(true);
  expect(transport.sent.at(-1)!.content).toBe('第一段第二段');
  expect(transport.sent[0]!.content).toContain('第一段');
});

test('前导注入：入站 prompt 携带 [Context: sender=…] 前缀（含 p2p 标注）', async () => {
  const { handler, transport, manager } = makeHandler();
  handler.register();
  transport.emit(MSG());
  await flush();
  expect(manager.submitted[0]!.prompt.startsWith('[Context: sender=u1, userid=u1, chat=u1 (p2p)]\n\n')).toBe(true);
});

test('AC4 桥：ask 渲染收流 finish=true；无效数字走提示流；作答转发 manager', async () => {
  const { handler, transport, manager } = makeHandler();
  handler.register();
  manager.nextEvents.push((emit) => {
    emit({ type: 'text_delta', chatKey: 'single:u1', text: '确认：' });
    emit({ type: 'ask', chatKey: 'single:u1', questions: [{ question: '选哪个？', options: [{ label: '甲' }, { label: '乙' }] }] });
  });
  transport.emit(MSG());
  await flush();
  const askFrame = transport.sent.at(-1)!;
  expect(askFrame.finish).toBe(true);
  expect(askFrame.content).toContain('1. 甲');
  expect(askFrame.content).toContain('2. 乙');
  // 无效数字 → 提示流（hasPendingAsk=true、answerPendingAsk=invalid_numeric）
  manager.pendingFlag = true;
  manager.answerResult = 'invalid_numeric';
  transport.emit(MSG({ content: '99' }));
  await flush();
  expect(transport.sent.at(-1)!.finish).toBe(true);
  expect(transport.sent.at(-1)!.content).toMatch(/无效选项/);
  // 合法数字 → 转发作答
  manager.answerResult = 'answered';
  transport.emit(MSG({ content: '1' }));
  await flush();
  expect(manager.answers.at(-1)).toBe('1');
});

test('turn_failed：终帧带通用错误文案 + onReplyError 上抛', async () => {
  const errs: Error[] = [];
  const { handler, transport, manager } = makeHandler(new FakeManager(), { onReplyError: (e) => errs.push(e) });
  handler.register();
  manager.nextEvents.push((emit) => {
    emit({ type: 'turn_failed', chatKey: 'single:u1', error: 'turn timeout exceeded' });
  });
  transport.emit(MSG());
  await flush();
  expect(transport.sent.at(-1)!.content).toContain('⏱ 回合超时');
  expect(transport.sent.at(-1)!.finish).toBe(true);
  expect(errs.length).toBe(1);
});

test('ConversationRateLimiter：双窗（假时钟）；会话间隔离；record() 逃逸记账后窗口更紧', () => {
  let now = 0;
  const lim = new ConversationRateLimiter({ perMinute: 3, perHour: 5, now: () => now });
  expect(lim.tryAcquire('k')).toBe(true);
  expect(lim.tryAcquire('k')).toBe(true);
  expect(lim.tryAcquire('k')).toBe(true);
  expect(lim.tryAcquire('k')).toBe(false);        // 分钟窗满
  now = 61_000;                                   // 分钟窗滑出、小时窗仍在
  expect(lim.tryAcquire('k')).toBe(true);         // 第 4 帧（小时窗 4/5）
  expect(lim.tryAcquire('k')).toBe(true);         // 第 5 帧（小时窗 5/5）
  expect(lim.tryAcquire('k')).toBe(false);        // 小时窗满（分钟窗已滑出——证双窗独立）
  expect(lim.tryAcquire('other')).toBe(true);     // 会话间隔离
  lim.record('k');                                // 逃逸记账：第 6 帧强行入账
  now = 2 * 61_000;                               // 分钟窗再滑出
  expect(lim.tryAcquire('k')).toBe(false);        // 小时窗 6/5 仍满——record 不是免费通行证
});

test('终帧有界等待→逃逸记账：预算耗尽时 final 仍发出、且记账压制后续刷新（注入假限流器）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-hdl-'));
  mkdirSync(join(dir, 'logs'), { recursive: true });
  const transport = new FakeTransport();
  const logger = new BotLogger({ level: 'debug', logDir: join(dir, 'logs'), console: false });
  const recorded: string[] = [];
  const exhausted = { tryAcquire: (_k: string) => false, record: (k: string) => recorded.push(k) }; // 永远没预算
  const handler = new AgentHandler(
    { transport, logger, manager: new FakeManager(), workspace: dir },
    { refreshIntervalMs: 5, rateLimiter: exhausted as unknown as ConversationRateLimiter, finalWaitIntervalMs: 5, finalWaitMaxTries: 3 },
  );
  handler.register();
  (handler as unknown as { opts: { } }); // no-op
  // 直接驱动 bridge 级行为：submit → turn_complete（FakeManager 默认无事件注入则无帧）——
  // 用 manager 注入终态：
  const mgr = new FakeManager();
  const handler2 = new AgentHandler(
    { transport, logger, manager: mgr, workspace: dir },
    { rateLimiter: exhausted as unknown as ConversationRateLimiter, finalWaitIntervalMs: 5, finalWaitMaxTries: 3 },
  );
  handler2.register();
  mgr.nextEvents.push((emit) => { emit({ type: 'turn_complete', chatKey: 'single:u1', finalText: 'X' }); });
  transport.emit(MSG());
  await flush(100);
  expect(transport.sent.length).toBe(1);          // 终帧在 3 次 × 5ms 等待后强制发出
  expect(transport.sent[0]!.finish).toBe(true);
  expect(recorded).toEqual(['single:u1']);        // 逃逸已记账
});

test('通知帧预算耗尽即丢（不等待不逃逸）：queue-full 通知被 exhausted 限流器吞掉', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-hdl-'));
  mkdirSync(join(dir, 'logs'), { recursive: true });
  const transport = new FakeTransport();
  const logger = new BotLogger({ level: 'debug', logDir: join(dir, 'logs'), console: false });
  const exhausted = { tryAcquire: (_k: string) => false, record: (_k: string) => {} };
  const mgr = new FakeManager();
  mgr.submitResult = 'queue-full';
  const handler = new AgentHandler(
    { transport, logger, manager: mgr, workspace: dir },
    { rateLimiter: exhausted as unknown as ConversationRateLimiter },
  );
  handler.register();
  transport.emit(MSG());
  await flush(50);
  expect(transport.sent.length).toBe(0); // 通知被丢（非关键）
});
```

`tests/unit/gateway-fatal.test.ts` 第二个用例重写（Gateway 构造签名变化）：

```ts
test('agent 回复失败传播进 Gateway 状态（lastError 持久化，不吞）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-fatal-'));
  mkdirSync(join(dir, 'logs'), { recursive: true });
  mkdirSync(join(dir, 'state'), { recursive: true });
  process.env.FAKE_CLAUDE_STATE_DIR = join(dir, 'state');
  process.env.FAKE_CLAUDE_SCENARIO = 'happy';
  const transport = new FakeTransport();
  transport.replyStreamImpl = async () => { throw new Error('reply rejected: errcode=40001'); };
  const logger = new BotLogger({ level: 'info', logDir: join(dir, 'logs'), console: false });
  const sessions = new SessionStore(join(dir, 'sessions'));
  const manager = new AgentManager({
    workspacePath: dir, sessions, logger,
    options: { claudeCommand: { command: process.execPath, argsPrefix: [join(import.meta.dir, '..', 'helpers', 'fake-claude.mjs')] } },
  });
  let gatewayRef: Gateway | null = null;
  const handler = new AgentHandler({ transport, logger, manager, workspace: dir }, {
    onReplyError: (e) => gatewayRef?.recordAgentError(e), // 与 createGateway 生产接线同构（R2-F5）
  });
  const gateway = new Gateway({ transport, logger, botDir: dir, handler });
  gatewayRef = gateway;
  await gateway.start();
  transport.emit({ type: 'textMessage', message: { msgid: 'm1', chatType: 'single', userId: 'u1', content: 'x', replyTo: { __brand: 'ReplyRef', reqId: 'r1' } } });
  await new Promise((r) => setTimeout(r, 600));
  const st = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as { lastError?: string };
  expect(st.lastError).toMatch(/reply rejected/);
  await gateway.stop();
});
```

- [ ] **Step 2: 跑测确认 FAIL** — Run: `bun test tests/unit/agent-handler.test.ts tests/unit/gateway-fatal.test.ts`
  Expected: FAIL（handler 模块不存在；Gateway 构造签名不认 handler）
- [ ] **Step 3: 实现**

  `src/handlers/agent.ts`：

```ts
import { randomUUID } from 'node:crypto';
import type { WeComTransport, ReplyRef, InboundTextMessage } from '../transport/types';
import type { BotLogger } from '../logger';
import type { AgentEvent, AgentEventHandler } from '../agent/manager';
import { renderAskText, buildContextPreamble, truncateUtf8 } from '../agent/parser';
import { chatKeyOf } from '../agent/session-store';

const REFRESH_INTERVAL_MS = 2_000;      // ≤30 帧/分钟（D5）
const MAX_CONTENT_BYTES = 20_000;       // SDK 硬限 20480 − 余量（D5）
const RATE_PER_MINUTE = 30;
const RATE_PER_HOUR = 1_000;
const FINAL_WAIT_INTERVAL_MS = 1_000;   // 终帧限流等待的重试间隔
const FINAL_WAIT_MAX_TRIES = 25;        // ≤25s < 平台 10min 的 30s 安全边距——到顶即有界逃逸

export interface AgentManagerPort {
  submit(chatKey: string, chatType: 'single' | 'group', userId: string, prompt: string, onEvent: AgentEventHandler): string;
  answerPendingAsk(chatKey: string, text: string): 'answered' | 'invalid_numeric' | 'none';
  hasPendingAsk(chatKey: string): boolean;
  expireStaleAsk(chatKey: string): boolean;
  closeAll(): Promise<void>;
}

/** 会话级限流：30 msg/min 与 1000/h 双滑窗（平台护栏 reply+proactive 合并口径）。
 *  刷新/通知帧预算耗尽即丢（幂等或非关键）；终帧在 send() 内有界等待预算，
 *  到顶才强制发送并 **record 强制记账**（超限可见：后续帧预算更紧 + ERROR 日志）——
 *  孤儿流仍比静默超限更糟，但账面不撒谎（D5 修订，plan 评审 R2-F1）。 */
export class ConversationRateLimiter {
  private windows = new Map<string, { min: number[]; hour: number[] }>();
  constructor(private opts: { perMinute?: number; perHour?: number; now?: () => number } = {}) {}
  tryAcquire(key: string): boolean {
    const now = this.opts.now ? this.opts.now() : Date.now();
    const w = this.prune(key, now);
    const perMin = this.opts.perMinute ?? RATE_PER_MINUTE;
    const perHour = this.opts.perHour ?? RATE_PER_HOUR;
    if (w.min.length >= perMin || w.hour.length >= perHour) {
      this.windows.set(key, w);
      return false;
    }
    w.min.push(now); w.hour.push(now);
    this.windows.set(key, w);
    return true;
  }
  /** 逃逸记账：强行发送的终帧也进窗口（诚实超限——不 invisibly 绕过护栏）。 */
  record(key: string): void {
    const now = this.opts.now ? this.opts.now() : Date.now();
    const w = this.prune(key, now);
    w.min.push(now); w.hour.push(now);
    this.windows.set(key, w);
  }
  private prune(key: string, now: number): { min: number[]; hour: number[] } {
    const w = this.windows.get(key) ?? { min: [], hour: [] };
    w.min = w.min.filter((t) => now - t < 60_000);
    w.hour = w.hour.filter((t) => now - t < 3_600_000);
    return w;
  }
}

interface TurnStream {
  ref: ReplyRef; streamId: string; banner: string; acc: string;
  lastFrameAt: number; closed: boolean;
  sendChain: Promise<void>;   // 每 chat 串行发送（F9：全量快照帧不得乱序）
}

export interface AgentHandlerOptions {
  onReplyError?: (err: Error) => void;
  refreshIntervalMs?: number;
  maxContentBytes?: number;
  /** 测试注入：限流器（假时钟）与终帧等待节奏（R3-F1 确定性覆盖） */
  rateLimiter?: ConversationRateLimiter;
  finalWaitIntervalMs?: number;
  finalWaitMaxTries?: number;
}

function userFacingError(error: string): string {
  if (error.includes('turn timeout')) return '⏱ 回合超时（10 分钟）已截断，请继续提问以重开会话';
  if (/spawn|ENOENT/i.test(error)) return '⚠️ claude 不可用，请联系管理员';
  return '⚠️ 处理失败，请稍后重试';
}

export class AgentHandler {
  private streams = new Map<string, TurnStream>();
  private limiter: ConversationRateLimiter;

  constructor(private deps: { transport: WeComTransport; logger: BotLogger; manager: AgentManagerPort; workspace: string }, private opts: AgentHandlerOptions = {}) {
    this.limiter = opts.rateLimiter ?? new ConversationRateLimiter();
  }

  register(): void {
    this.deps.transport.on((event) => {
      if (event.type !== 'textMessage') return;
      void this.onText(event.message);
    });
  }

  async stop(): Promise<void> {
    await this.deps.manager.closeAll();
    this.streams.clear();
  }

  private async onText(m: InboundTextMessage): Promise<void> {
    if (m.chatType === 'group' && !m.chatId) {
      this.deps.logger.debug('group text without chatId ignored', { msgid: m.msgid });
      return;
    }
    const chatKey = chatKeyOf(m);
    // 顺序硬约束（plan 评审 F4）：先判过期——过期 ask 绝不作答，入站按新回合处理
    if (this.deps.manager.expireStaleAsk(chatKey)) {
      const st = this.ensureStream(m.replyTo, chatKey);
      st.banner = `${st.banner}⚠️ 上一个问题已超时失效，已开启新会话\n\n`;
      st.ref = m.replyTo; // 过期后的新回合绑最新回调（F5）
    } else if (this.deps.manager.hasPendingAsk(chatKey)) {
      const r = this.deps.manager.answerPendingAsk(chatKey, m.content, m.userId);
      if (r === 'answered') {
        const st = this.streams.get(chatKey);
        if (st && !st.closed) st.ref = m.replyTo; // 答复后的续输出绑作答回调（F5）
        return;
      }
      if (r === 'invalid_numeric') {
        await this.notice(m.replyTo, chatKey, '无效选项，请回复数字（如 1 或 1,3），或直接回复文字。');
        return; // ask 续流（this.streams 中的 pending 续流）不受影响
      }
      // 'none'：pending 已死——按新消息继续
    }
    const prompt = buildContextPreamble({ userId: m.userId, chatKey, chatType: m.chatType }) + m.content;
    const verdict = this.deps.manager.submit(chatKey, m.chatType, m.userId, prompt, (ev) => this.bridge(m.replyTo, chatKey, ev));
    if (verdict === 'queue-full') {
      await this.notice(m.replyTo, chatKey, '消息队列已满，请稍后再试。');
    }
    // 'queued'：不打扰——回合结束后的批回合回执（AC3）
  }

  private async bridge(ref: ReplyRef, chatKey: string, ev: AgentEvent): Promise<void> {
    const st = this.ensureStream(ref, chatKey);
    const cap = this.opts.maxContentBytes ?? MAX_CONTENT_BYTES;
    switch (ev.type) {
      case 'text_delta':
        st.acc += ev.text;
        await this.maybeRefresh(chatKey);
        return;
      case 'ask': {
        // 问题渲染保底预算（plan 评审 F7）：先截已产出文本，问题清单拿独立余量
        const askText = renderAskText(ev.questions);
        const askBudget = Math.min(Buffer.byteLength(askText, 'utf8'), Math.max(cap - 200, Math.floor(cap / 2)));
        const accBudget = Math.max(cap - askBudget - 16, 0);
        const head = st.acc ? `${truncateUtf8(st.banner + st.acc, accBudget)}\n\n` : st.banner;
        const content = truncateUtf8(head + askText, cap);
        await this.send(st, content, true); // 闭流（D7 生命周期）
        this.streams.set(chatKey, { ref: st.ref, streamId: randomUUID(), banner: '', acc: '', lastFrameAt: 0, closed: false, sendChain: Promise.resolve() }); // 答复后新流
        return;
      }
      case 'turn_complete': {
        const content = `${st.banner}${st.acc}` || '（无输出）';
        await this.send(st, truncateUtf8(content, cap), true);
        this.streams.delete(chatKey);
        return;
      }
      case 'turn_failed': {
        const content = `${st.banner}${st.acc}${st.acc ? '\n\n' : ''}${userFacingError(ev.error)}`;
        try {
          await this.send(st, truncateUtf8(content, cap), true);
        } finally {
          this.deps.logger.error('turn failed', { chatKey, error: ev.error });
          this.opts.onReplyError?.(new Error(ev.error));
        }
        this.streams.delete(chatKey);
        return;
      }
      case 'ask_expired':
        this.deps.logger.warn('ask expired', { chatKey });
        return;
    }
  }

  private ensureStream(ref: ReplyRef, chatKey: string): TurnStream {
    let st = this.streams.get(chatKey);
    if (!st || st.closed) {
      st = { ref, streamId: randomUUID(), banner: '', acc: '', lastFrameAt: 0, closed: false, sendChain: Promise.resolve() };
      this.streams.set(chatKey, st);
    }
    return st;
  }

  private async maybeRefresh(chatKey: string): Promise<void> {
    const st = this.streams.get(chatKey);
    if (!st || st.closed) return;
    const interval = this.opts.refreshIntervalMs ?? REFRESH_INTERVAL_MS;
    const now = Date.now();
    if (now - st.lastFrameAt < interval) return;
    if (!this.limiter.tryAcquire(chatKey)) return; // 预算耗尽丢刷新——幂等无损（D5）
    st.lastFrameAt = now;
    st.sendChain = st.sendChain.then(() => this.rawSend(st, truncateUtf8(st.banner + st.acc, this.opts.maxContentBytes ?? MAX_CONTENT_BYTES), false));
    await st.sendChain;
  }

  /** 通知帧（队列满/无效选项提示）：一次性流，**不触碰 this.streams**（plan 评审 R2-F4：
   *  替换活动流会孤儿化运行中回合的流），预算耗尽即丢（非关键，debug 留痕）。 */
  private async notice(ref: ReplyRef, chatKey: string, content: string): Promise<void> {
    if (!this.limiter.tryAcquire(chatKey)) {
      this.deps.logger.debug('notice dropped by rate limiter', { chatKey });
      return;
    }
    const ephemeral: TurnStream = { ref, streamId: randomUUID(), banner: '', acc: '', lastFrameAt: 0, closed: false, sendChain: Promise.resolve() };
    await this.rawSend(ephemeral, content, true);
  }

  /** 终帧发送：有界等待限流预算（≤25s）；到顶强制发送 + record 记账 + ERROR 告警（D5 修订）。 */
  private async send(st: TurnStream, content: string, finish: boolean): Promise<void> {
    if (finish) {
      const chatKey = this.chatKeyOfStream(st);
      const interval = this.opts.finalWaitIntervalMs ?? FINAL_WAIT_INTERVAL_MS;
      const maxTries = this.opts.finalWaitMaxTries ?? FINAL_WAIT_MAX_TRIES;
      let acquired = false;
      for (let i = 0; i < maxTries && !(acquired = this.limiter.tryAcquire(chatKey)); i++) {
        await new Promise((r) => setTimeout(r, interval));
      }
      if (!acquired) {
        this.limiter.record(chatKey); // 诚实超限：逃逸帧也进窗口
        this.deps.logger.error('final frame sent over conversation rate limit (bounded escape)', { chatKey });
      }
    }
    st.sendChain = st.sendChain.then(() => this.rawSend(st, content, finish));
    await st.sendChain;
  }

  private chatKeyOfStream(st: TurnStream): string {
    for (const [k, v] of this.streams) if (v === st) return k;
    return st.ref.reqId;
  }

  private async rawSend(st: TurnStream, content: string, finish: boolean): Promise<void> {
    try {
      await this.deps.transport.replyStream(st.ref, st.streamId, content, finish);
      if (finish) st.closed = true;
    } catch (e) {
      const err = e as Error;
      this.deps.logger.error('reply stream failed', { reqId: st.ref.reqId, err: err.message, finish });
      if (finish) st.closed = true; // 终帧失败也闭——不重试（错误已上抛状态面）
      this.opts.onReplyError?.(err);
    }
  }
}
```

  `src/gateway.ts` 修改：构造 opts 增 `handler`，`start()` 内 `new EchoHandler(...)` 替换为 `this.opts.handler.register()`，`stop()` 在 transport.stop 前加 `await this.opts.handler.stop?.()`；新增公开错误入口 `recordAgentError`（plan 评审 F8——agent 失败面接进 lastError）：

```ts
export interface BotHandler { register(): void; stop?(): Promise<void> }

export class Gateway {
  constructor(private opts: { transport: WeComTransport; logger: BotLogger; botDir: string; pid?: number; handler: BotHandler }) { /* 原体 */ }
  async start(): Promise<void> {
    this.opts.handler.register(); // 认证完成前 handler 就位（W1 既有注释语义不变）
    await this.opts.transport.start();
    /* 原体 */
  }
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.opts.handler.stop?.().catch((e: unknown) => this.opts.logger.error('handler stop failed', { err: (e as Error).message }));
    await this.opts.transport.stop();
    /* 原体 persist */
  }
  /** agent 层失败入口（F8）：与 transport error 事件同道持久化 lastError */
  recordAgentError(err: Error): void {
    this.onEvent({ type: 'error', error: err });
  }
}
```

  `createGateway` 增第三参并组装 agent 层（config 键按 Task 1；onReplyError 经 recordAgentError 接进 Gateway 状态面——F8）：

```ts
export interface AgentOverrides {
  claudeCommand?: ClaudeCommand; idleTtlMs?: number; turnTimeoutMs?: number; refreshIntervalMs?: number; maxConcurrentTurns?: number;
}

export async function createGateway(workspace: string, overrides: Partial<TransportOptions> = {}, agent: AgentOverrides = {}) {
  /* 原 loadWorkspace/credentials/logger/transport 段不变 */
  const sessions = new SessionStore(join(ws.botDir, 'sessions'));
  const manager = new AgentManager({
    workspacePath: workspace, sessions, logger,
    options: {
      idleTtlMs: (ws.config.sessionIdleTtlMinutes ?? 60) * 60_000,
      maxConcurrentTurns: ws.config.maxConcurrentTurns,
      model: ws.config.claudeModel,
      ...(agent.claudeCommand ? { claudeCommand: agent.claudeCommand } : {}),
      ...(agent.idleTtlMs !== undefined ? { idleTtlMs: agent.idleTtlMs } : {}),
      ...(agent.turnTimeoutMs !== undefined ? { turnTimeoutMs: agent.turnTimeoutMs } : {}),
      ...(agent.maxConcurrentTurns !== undefined ? { maxConcurrentTurns: agent.maxConcurrentTurns } : {}),
    },
  });
  let gatewayRef: Gateway | null = null;
  const handler = new AgentHandler({ transport, logger, manager, workspace }, {
    onReplyError: (e) => gatewayRef?.recordAgentError(e),   // F8：agent 失败进 state.json lastError
    ...(agent.refreshIntervalMs !== undefined ? { refreshIntervalMs: agent.refreshIntervalMs } : {}),
  });
  const gateway = new Gateway({ transport, logger, botDir: ws.botDir, handler });
  gatewayRef = gateway;
  return { gateway, workspace: ws };
}
```

  删除：`src/handlers/echo.ts`、`tests/integration/echo.test.ts`；`src/gateway.ts` 顶部 EchoHandler import 移除。gateway-fatal.test.ts 第一个用例补 `handler: { register() {} }`。
- [ ] **Step 4: 跑测确认 PASS** — Run: `bun run typecheck && bun test tests/unit tests/integration`
  Expected: PASS（transport.test.ts 的 kicked-恢复用例走 recorder 不经 handler，不受影响；cli.test.ts 不依赖 echo——若 start 轮询语义受 handler 影响，按失败信息修）
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(agent): WeCom stream bridge handler with throttle/rate/timeout mapping; gateway wires BotHandler; remove echo"`

---

### **Checkpoint B**（Task 7 后）

- [ ] Run: `bun run typecheck && bun test tests/unit tests/integration && bun run build && bash scripts/check-dist.sh && bun run smoke`
- [ ] 确认：全绿；`grep -r "EchoHandler" src/ tests/` 零命中。

---

### Task 8: 集成测试 AC1–AC5 + 群聊路径

**Files:**
- Create: `tests/integration/agent.test.ts`
-（Task 7 已删 `tests/integration/echo.test.ts`）

**Interfaces:**
- Consumes: `createGateway(ws, {wsUrl…}, agent overrides)`（Task 7）、`MockWecomServer.pushTextMessage(chatType/chatid)`（Task 2）、fake claude（Task 5）。

- [ ] **Step 1: 写集成测试**（`tests/integration/agent.test.ts`；全部经 mock 服务端 + fake claude 走真实 Gateway 全链路）

```ts
import { test, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '../../src/gateway';

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
  const srv = new (await import('../helpers/mock-wecom-server')).MockWecomServer();
  const { url } = await srv.start();
  const { gateway } = await createGateway(ws, { wsUrl: url, ...FAST }, {
    claudeCommand: { command: process.execPath, argsPrefix: [HELPER] },
    refreshIntervalMs: 10,
    ...agent,
  });
  await gateway.start();
  return { ws, srv, gateway, stateDir };
}

const streamsOf = (srv: { sentFrames: Array<{ body?: unknown }> }) =>
  srv.sentFrames.map((f) => (f.body as { stream?: { id: string; content: string; finish: boolean } }).stream!);

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

test('AC5：无输出超时回合干净收流（压缩 turnTimeoutMs）', async () => {
  const { srv, gateway } = await setup('no-output', { turnTimeoutMs: 400 });
  srv.pushTextMessage('req-1', { msgid: 'm1', userId: 'u1', content: '慢' });
  await waitUntil(() => streamsOf(srv).some((s) => s.finish), 10_000);
  const f = streamsOf(srv).at(-1)!;
  expect(f.finish).toBe(true);
  expect(f.content).toContain('⏱ 回合超时');
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
```

- [ ] **Step 2: 跑测确认 FAIL→修至 PASS** — Run: `bun test tests/integration/agent.test.ts`
  Expected: 初跑暴露桥接/时序缺陷——按失败信息修 `manager.ts`/`agent.ts`（这是集成层的价值所在：修到全绿）
- [ ] **Step 3: 全量门** — Run: `bun run typecheck && bun test tests/unit tests/integration`
  Expected: PASS
- [ ] **Step 4: Commit** — `git add tests/integration/agent.test.ts && git commit -m "test(agent): AC1-AC5 integration via mock wecom + fake claude, group chat path"`

---

### Task 9: SPEC.md / README / CHANGELOG + 终检

**Files:**
- Modify: `SPEC.md`（Echo 节替换为 Agent 层契约）
- Modify: `README.md`（config 键说明）
- Modify: `CHANGELOG.md`

**Interfaces:** 无代码——文档只写集成测试实际验证到的行为（W1 D2 评审纪律）。

- [ ] **Step 1: SPEC.md**——删除 `## Echo（W1 契约）` 节，新增：

```md
## Agent 会话层（W2 契约）

- 会话：每 chat 一个 claude 会话（单聊 `single:<userid>`、群聊 `group:<chatid>`——群帧缺 chatid
  即忽略）；`.bot/sessions/<base64url(chatKey)>.json`，原子写 0600；惰性 TTL：入站时
  `session_idle_ttl_minutes`（默认 60）内 resume 同 `claudeSessionId`，过期新建。
- spawn：`claude --print --output-format stream-json --input-format stream-json --verbose
  --permission-prompt-tool stdio --permission-mode bypassPermissions --append-system-prompt <sys>
  --model <claudeModel>`（缺省 glm-5.3-flash），cwd=工作区，env 无 CLAUDECODE；回合结束走
  收割梯子（stdin.end→2s→SIGTERM→1s→SIGKILL——claude --print 等 stdin EOF）。
- 流桥：回合输出经 `aibot_respond_msg` 流式回传——`stream.id` 回合内恒定、刷新帧携带全量
  内容（≥2s 节流）、终帧 `finish=true`；内容上限 20000 字节（SDK 20480），字节安全截断。
  实测（集成测试，mock 服务端 + fake claude）：多帧刷新同 id、终帧收尾、超时截断。
- 平台护栏：会话级 30 msg/min 与 1000/h 双窗限流，覆盖全部出站帧——刷新/通知帧预算耗尽
  即丢（刷新幂等、通知非关键）；终帧有界等待预算（≤25 s）后强制发送并**逃逸记账**
  （record 进双窗 + ERROR 日志——超限可见，孤儿流比静默超限更糟）；每用户 ≤3 in-flight
  （运行回合 + ask 等待按运行回合单计，跨会话；群批量回合与群内作答者均计入）；全局
  `maxConcurrentTurns`（默认 4，资源帽）；每 chat 队列上限 20。
- 超时：按**流段**计——spawn→本段终局（ask 闭流或回合终态）默认 570 s（平台 10 min −
  30 s 边距）；ask 等待期不计时（进程寿命由会话 TTL 惰性约束 + 关停收割兜底）；作答后
  续段重获整段预算。到点终帧「⏱ 回合超时」+ SIGINT 收割（无视信号的子进程由收割梯子
  升级 SIGKILL，全程有界）。实测（压缩注入）：无输出回合、晚输出回合、无视信号子进程
  均按期收流不悬挂。
- 排队：回合进行中同 chat 消息入队（上限 20，溢出回执），回合结束按序合为一个批量回合。
- AskUserQuestion 文本回退：ask 到达即闭流（已产出文本 + 扁平编号清单），数字回复
  （`1` / `1,3`，全角逗号容忍）确定性映射回 control_response；非数字文本作为首题自由
  答案；越界/单选多挑提示重试；pending ask 随会话 TTL 过期。群内任何成员可作答（v1）。
- 失败面：回合失败终帧通用文案（细节入日志）+ lastError；spawn 失败明确回执；resume
  「No conversation found」自动 fresh 重试恰好一次。实测：crash/garbage/超时路径均收流。
```

- [ ] **Step 2: README.md** config 节追加三键一行说明；CHANGELOG.md 加 W2 条目（沿用既有格式）。
- [ ] **Step 3: 终检（Checkpoint C）** — Run: `bun run typecheck && bun test tests/unit tests/integration && bun run build && bash scripts/check-dist.sh && bun run smoke`
  Expected: 全绿；`git status` 干净
- [ ] **Step 4: Commit** — `git add SPEC.md README.md CHANGELOG.md && git commit -m "docs: W2 agent session layer contract (verified-behavior only)"`

---

## Risk Notes（执行者注意）

1. **fake-claude env 继承**：manager `buildEnv()` 复制 `process.env`——测试进程里设置的 `FAKE_CLAUDE_*` 自然传给子进程（集成测试用例间切换 scenario 即改 `process.env` 后再 submit；注意 bun test 用例并发时的 env 竞态——agent.test.ts 每用例独立 setup 且顺序执行，`bun test` 默认串行）。
2. **manager.ts 落地纪律**：Task 6 Step 3 代码块为蓝本——顶部 import（含 `parseNumericReply`）、模块级 `timedOutProcs`/`resumeNotFoundProcs` WeakSet 哨兵；typecheck 必须零错误，出现计划未覆盖的编译缺口时按最小实现补齐并在 PR 描述列出偏差。
3. **gateway-fatal.test.ts 第一用例**：补 `handler: { register() {} }` 即可，断言不动。
4. **transport.test.ts kicked 用例**：不经 handler（recorder 直连），预期不受 Gateway 签名变化影响；若因 createGateway 签名编译失败，仅修 import/构造处。
5. **时序压缩值**：集成测试的 idleTtlMs=400/turnTimeoutMs=400/refreshIntervalMs=10 若在 CI 抖动，先加大 waitUntil 上限而非加 sleep；禁止放宽断言。
6. **决策分歧记录**：D7 跨题混合数字选择（`1,3` 跨两题）为确定性分配——codex 曾建议拒绝，decisions.md 已记分歧与理由；执行者不得"顺手"改成拒绝语义。
