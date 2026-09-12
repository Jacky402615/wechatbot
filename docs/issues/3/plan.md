# Commands, Access Control, Group Policy, Welcome Implementation Plan

**Goal:** wechatbot W3——网关命令（/new /stop /status /help）、access.json 三层访问控制（admin/approved/rejected）+ 群 allowlist、@-提及群策略、enter_chat 5 秒欢迎。

**Architecture:** 在 W2 的单一入站分派点 `AgentHandler.onText` 顶部前置 access gate 与命令分派（D1：transport `on()` 无传播控制，独立 handler 拦不住）；新增两个纯模块 `src/access.ts`（access.json 加载/校验/帧内不可变快照）与 `src/commands.ts`（命令解析 + 全部用户文案 + @-提及剥离）；manager 增 `abortChat`（哨兵 + SIGINT，EOF 路径发中止终帧）；transport 事件面增 `enterChat`/`feedbackEvent` 与 `replyWelcome`/`connectionStatus`。

**Tech Stack:** TypeScript (bun runtime)、`@wecom/aibot-node-sdk@1.0.7`、bun:test（unit + integration 双桩：mock WeCom WS 服务端 + fake claude）。

**Spec:** `docs/issues/3/decisions.md`

## Global Constraints

- AC1: 四命令（/new /stop /status /help）应答正确；任何命令不进 agent 会话（不 spawn claude、不写 sessions/）（spec S7–S10）。
- AC2: 非白名单 p2p 发送者得到拒绝文案；无会话生成（无 sessions 文件、无 stdin.jsonl）（S11）。
- AC3: allow-listed 群内 @ 机器人路由到该群会话（`group:<chatid>`）；非 listed 群被忽略（S3）。
- AC4: 每日首个 `enter_chat` 5 秒内应答（allowed→欢迎+命令清单；rejected/unknown→拒绝文案）（S12）。
- access gate 先于命令解析：陌生人/拒绝者的任何输入（含命令）只得拒绝文案，不披露命令面（D1/D2）。
- **一次入站帧恰好一次 `access.load()`**：gate、命令分派、/status 名单共用同一不可变快照——热编辑不得撕裂单帧授权（plan 评审 R1-F2）。
- tier 优先级 admin > rejected > approved；rejected 与 unknown 同文案（D2）。
- 群流量授权 = `groups` allowlist（chatid）；群内不查 approved，rejected 群内静默忽略（D2）。
- `groups` 非空而 `groupMentionName` 缺失 ⇒ 启动 `ConfigError`（D3）。
- @ 匹配带 token 边界：`@botbot` 不得命中 `@bot`（D3）。
- /stop 有在跑/中止中回合时不另发 ack——中止终帧即 clean stream close（D4，`'stopping'` 态同此——双击不产生 idle 误报）；/new 恒发重置回执。
- welcome 不走 ConversationRateLimiter（独立 respond 通道）（D5）；feedback_event 仅 info 日志、不记内容（D5/D8）。
- 拒绝回执逐条经 notice()（预算耗尽即丢），日志不记消息内容（D8/D9）。
- /status 仅 admin 单聊可用（D6）；群内 /status 拒答不披露 roster；状态面含 connected+authenticated 双字段。
- access.json 启动损坏 ⇒ 响亮失败；运行期重读失败 ⇒ last-known-good + ERROR 日志（D2）。
- 回归红线：W1/W2 全部既有测试保持绿（`bun test` 全量）——**agent.test.ts 既有 setup 须补写 approved access.json**（空 access 下 W2 的 u1 全变陌生人）；transport/agent 契约不回退。

## Tasks

### Task 1: `src/access.ts` — access.json 纯模块（帧内不可变快照）

**Files:**
- Create: `src/access.ts`
- Test: `tests/unit/access.test.ts`

**Interfaces:**
- Consumes: 无（纯模块 + node:fs）
- Produces:
  - `export type AccessTier = 'admin' | 'approved' | 'rejected' | 'unknown'`
  - `export interface AccessState { admin: string[]; approved: string[]; rejected: string[]; groups: string[] }`
  - `export interface AccessSnapshot { tierOf(userId: string): AccessTier; groupAllowed(chatId: string): boolean; readonly admin: readonly string[]; readonly approved: readonly string[]; readonly rejected: readonly string[]; readonly groups: readonly string[] }`
  - `export class AccessError extends ConfigError {}`（plan 评审 R3-F1：ConfigError 子类——启动失败面与 W1/W2 配置错误同契约）
  - `export function parseAccess(text: string, path: string): AccessState`（形状不符抛 AccessError）
  - `export class AccessGate { constructor(accessPath: string, opts?: { onError?: (err: Error) => void }); load(): AccessSnapshot }`（构造即加载——启动损坏上抛；load 失败留 last-known-good）

- [x] **Step 1: Write the failing test**（`tests/unit/access.test.ts`）

```ts
import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccessGate, AccessError, parseAccess } from '../../src/access';

const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'wb-acc-')); mkdirSync(join(d, '.bot'), { recursive: true }); return d; };
const write = (dir: string, json: unknown) => writeFileSync(join(dir, '.bot', 'access.json'), JSON.stringify(json) + '\n');

test('parseAccess：空对象合法（deny-all 缺省）；四键可选', () => {
  const s = parseAccess('{}', 'p');
  expect(s).toEqual({ admin: [], approved: [], rejected: [], groups: [] });
});

test('parseAccess：非法形状抛 AccessError（非数组/非字符串/空串/列表内重复/未知键）', () => {
  expect(() => parseAccess('{"admin": "x"}', 'p')).toThrow(AccessError);
  expect(() => parseAccess('{"approved": [1]}', 'p')).toThrow(AccessError);
  expect(() => parseAccess('{"rejected": [""]}', 'p')).toThrow(AccessError);
  expect(() => parseAccess('{"groups": ["g", "g"]}', 'p')).toThrow(AccessError);
  expect(() => parseAccess('not json', 'p')).toThrow(AccessError);
  expect(() => parseAccess('{"unknownKey": []}', 'p')).toThrow(AccessError); // 未知键拒绝（严格配置同构）
});

test('tierOf：admin > rejected > approved > unknown；跨列表重叠按优先级', () => {
  const dir = tmp(); write(dir, { admin: ['a'], approved: ['b', 'x'], rejected: ['x', 'c'] });
  const g = new AccessGate(join(dir, '.bot', 'access.json'));
  const snap = g.load();
  expect(snap.tierOf('a')).toBe('admin');
  expect(snap.tierOf('x')).toBe('rejected'); // approved+rejected 冲突 ⇒ deny 优先
  expect(snap.tierOf('b')).toBe('approved');
  expect(snap.tierOf('c')).toBe('rejected');
  expect(snap.tierOf('stranger')).toBe('unknown');
});

test('帧内快照不可变（plan 评审 R1-F2）：load 后改文件，本快照判定不变；下次 load 才见新态', () => {
  const dir = tmp(); write(dir, { approved: ['b'], groups: ['g1'] });
  const path = join(dir, '.bot', 'access.json');
  const g = new AccessGate(path);
  const snap = g.load();
  write(dir, { approved: [], groups: ['g2'] });
  expect(snap.tierOf('b')).toBe('approved');  // 旧快照仍认
  expect(snap.groupAllowed('g1')).toBe(true);
  expect(snap.groupAllowed('g2')).toBe(false);
  const snap2 = g.load();                     // 新帧新快照
  expect(snap2.tierOf('b')).toBe('unknown');
  expect(snap2.groupAllowed('g2')).toBe(true);
});

test('热重读失败 ⇒ last-known-good + onError（不抛、不崩）', () => {
  const dir = tmp(); write(dir, { approved: ['b'] });
  const path = join(dir, '.bot', 'access.json');
  const errs: string[] = [];
  const g = new AccessGate(path, { onError: (e) => errs.push(e.message) });
  writeFileSync(path, '{broken'); // 运行期写坏
  const snap = g.load();
  expect(snap.tierOf('b')).toBe('approved'); // 沿用旧快照
  expect(errs.length).toBe(1);
});

test('构造即加载：启动损坏直接上抛 AccessError', () => {
  const dir = tmp(); writeFileSync(join(dir, '.bot', 'access.json'), 'garbage');
  expect(() => new AccessGate(join(dir, '.bot', 'access.json'))).toThrow(AccessError);
});

test('文件缺失 ⇒ ENOENT 同为 AccessError（启动响亮）', () => {
  const dir = tmp();
  expect(() => new AccessGate(join(dir, '.bot', 'access.json'))).toThrow(AccessError);
});
```

- [x] **Step 2: Run it and verify it FAILS** — Run: `bun test tests/unit/access.test.ts` Expected: FAIL（`Cannot find module '../../src/access'`）
- [x] **Step 3: Write the minimal implementation**（`src/access.ts`）

```ts
import { readFileSync } from 'node:fs';
import { ConfigError } from './config';

export type AccessTier = 'admin' | 'approved' | 'rejected' | 'unknown';

export interface AccessState {
  admin: string[];
  approved: string[];
  rejected: string[];
  groups: string[];
}

/** 帧内不可变快照（plan 评审 R1-F2）：一次入站帧 load() 一次，gate/命令/status 共用同一版本。 */
export interface AccessSnapshot {
  tierOf(userId: string): AccessTier;
  groupAllowed(chatId: string): boolean;
  readonly admin: readonly string[];
  readonly approved: readonly string[];
  readonly rejected: readonly string[];
  readonly groups: readonly string[];
}

/** plan 评审 R3-F1：ConfigError 子类——启动失败面与 W1/W2 配置错误同契约（统一 instanceof 消费）。 */
export class AccessError extends ConfigError {}

const KEYS = ['admin', 'approved', 'rejected', 'groups'] as const;

/** 严格形状校验：未知键、非字符串数组、空串、列表内重复 ⇒ AccessError（W1 严格配置同构） */
export function parseAccess(text: string, path: string): AccessState {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch (e) {
    throw new AccessError(`invalid JSON in ${path}: ${(e as Error).message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AccessError(`access file must be a JSON object: ${path}`);
  }
  const unknownKeys = Object.keys(raw).filter((k) => !KEYS.includes(k as (typeof KEYS)[number]));
  if (unknownKeys.length > 0) {
    throw new AccessError(`unknown key(s) ${unknownKeys.join(',')} in ${path} (allowed: ${KEYS.join(',')})`);
  }
  const state = { admin: [], approved: [], rejected: [], groups: [] } as AccessState;
  for (const key of KEYS) {
    const v = raw[key];
    if (v === undefined) continue;
    if (!Array.isArray(v)) throw new AccessError(`${key} must be a string array in ${path}`);
    const ids = v.map((id) => {
      if (typeof id !== 'string' || id.trim() === '') throw new AccessError(`${key} entries must be non-empty strings in ${path}`);
      return id.trim();
    });
    const dup = ids.find((id, i) => ids.indexOf(id) !== i);
    if (dup !== undefined) throw new AccessError(`duplicate entry "${dup}" in ${key} of ${path}`);
    state[key] = ids;
  }
  return state;
}

const snapshotOf = (state: AccessState): AccessSnapshot => ({
  // tier 优先级 admin > rejected > approved（approved+rejected 冲突 ⇒ deny 优先，D2）
  tierOf(userId) {
    if (state.admin.includes(userId)) return 'admin';
    if (state.rejected.includes(userId)) return 'rejected';
    if (state.approved.includes(userId)) return 'approved';
    return 'unknown';
  },
  groupAllowed(chatId) { return state.groups.includes(chatId); },
  admin: [...state.admin],
  approved: [...state.approved],
  rejected: [...state.rejected],
  groups: [...state.groups],
});

/** 每个入站事件 load() 一次；热重读失败沿用 last-known-good + onError（fail-visible，D2）。 */
export class AccessGate {
  private state: AccessState;

  constructor(private accessPath: string, private opts: { onError?: (err: Error) => void } = {}) {
    let text: string;
    try {
      text = readFileSync(accessPath, 'utf8');
    } catch (e) {
      // ENOENT/权限等读失败一律 AccessError（plan 评审 R2-F1）——启动响亮、类型如一
      throw new AccessError(`cannot read ${accessPath}: ${(e as Error).message}`);
    }
    this.state = parseAccess(text, accessPath); // 启动损坏上抛
  }

  load(): AccessSnapshot {
    try {
      this.state = parseAccess(readFileSync(this.accessPath, 'utf8'), this.accessPath);
    } catch (e) {
      this.opts.onError?.(e as Error);
    }
    return snapshotOf(this.state);
  }
}
```

- [x] **Step 4: Run it and verify it PASSES** — Run: `bun test tests/unit/access.test.ts` Expected: PASS（7 tests）
- [x] **Step 5: Commit** — `git add src/access.ts tests/unit/access.test.ts && git commit -m "W3: access.json pure module — strict parse, frame-immutable snapshot, last-known-good hot reload"`

### Task 2: `src/commands.ts` — 命令解析与用户文案

**Files:**
- Create: `src/commands.ts`
- Test: `tests/unit/commands.test.ts`

**Interfaces:**
- Consumes: 无（纯函数）
- Produces:
  - `export interface ParsedCommand { name: string; args: string }`
  - `export function parseCommand(text: string): ParsedCommand | null`
  - `export function stripMention(content: string, mentionName: string | undefined): string | null`
  - `export const REJECTION_TEXT: string`
  - `export function helpText(): string`
  - `export function welcomeText(): string`
  - `export function statusText(snap: { connected: boolean; authenticated: boolean; admins: readonly string[]; approved: readonly string[]; groups: readonly string[]; activeSessions: number; inFlight: number }): string`

- [ ] **Step 1: Write the failing test**（`tests/unit/commands.test.ts`）

```ts
import { test, expect } from 'bun:test';
import { parseCommand, stripMention, helpText, welcomeText, statusText, REJECTION_TEXT } from '../../src/commands';

test('parseCommand：/name + args；大小写归一；非命令返回 null', () => {
  expect(parseCommand('/stop')).toEqual({ name: 'stop', args: '' });
  expect(parseCommand('/NEW  now')).toEqual({ name: 'new', args: 'now' });
  expect(parseCommand('  /help  怎么用 ')).toEqual({ name: 'help', args: '怎么用' });
  expect(parseCommand('普通消息')).toBeNull();
  expect(parseCommand('/')).toBeNull();
  expect(parseCommand('@bot /stop')).toBeNull(); // @ 前缀由 stripMention 先剥（群路径）
});

test('stripMention：token 边界——@bot 命中、@botbot 不命中；剥离后余文保留', () => {
  expect(stripMention('@小助手 帮我查一下', '小助手')).toBe('帮我查一下');
  expect(stripMention('@小助手', '小助手')).toBe('');
  expect(stripMention('@小助手你好', '小助手')).toBeNull();    // token 边界：名字后必须空白或串尾
  expect(stripMention('你好 @小助手', '小助手')).toBeNull();    // 必须前导
  expect(stripMention('随便聊聊', '小助手')).toBeNull();
  expect(stripMention('@小助手 /stop', '小助手')).toBe('/stop');
  expect(stripMention('任何', undefined)).toBeNull();          // 未配置名 ⇒ 群帧一律不匹配
});

test('文案：REJECTION_TEXT 不含命令字样；help/welcome/status 渲染（含 authenticated 双态）', () => {
  expect(REJECTION_TEXT).toContain('未被授权');
  expect(REJECTION_TEXT).not.toMatch(/\/(new|stop|status|help)/);
  expect(helpText()).toContain('/new');
  expect(helpText()).toContain('/stop');
  expect(helpText()).toContain('/status');
  expect(helpText()).toContain('/help');
  expect(welcomeText()).toContain('/help'); // 欢迎语携带命令清单（AC4）
  const s = statusText({ connected: true, authenticated: true, admins: ['a'], approved: ['b', 'c'], groups: ['g1'], activeSessions: 2, inFlight: 1 });
  expect(s).toContain('已连接');
  expect(s).toContain('已认证');
  expect(s).toContain('a');
  expect(s).toContain('g1');
  expect(statusText({ connected: true, authenticated: false, admins: [], approved: [], groups: [], activeSessions: 0, inFlight: 0 })).toContain('未认证');
});
```

- [ ] **Step 2: Run it and verify it FAILS** — Run: `bun test tests/unit/commands.test.ts` Expected: FAIL（module not found）
- [ ] **Step 3: Write the minimal implementation**（`src/commands.ts`）

```ts
export interface ParsedCommand { name: string; args: string }

/** feishubot 同款：前导 /<name>，名字归一小写——/STOP 与 /stop 同分派。 */
export function parseCommand(text: string): ParsedCommand | null {
  const m = text.trim().match(/^\/([\w-]+)\s*([\s\S]*)$/);
  if (!m) return null;
  return { name: m[1]!.toLowerCase(), args: m[2]! };
}

/** 群 @-提及剥离（D3）：content trim 后须以 `@<mentionName>` 开头且带 token 边界
 *  （名字后是空白或串尾——@botbot 不得命中 @bot）；未配置名 ⇒ 恒 null（群帧全忽略）。 */
export function stripMention(content: string, mentionName: string | undefined): string | null {
  if (!mentionName) return null;
  const t = content.trimStart();
  if (!t.startsWith(`@${mentionName}`)) return null;
  const rest = t.slice(1 + mentionName.length);
  if (rest !== '' && !/^\s/.test(rest)) return null; // token 边界
  return rest.trim();
}

export const REJECTION_TEXT = '🔒 你尚未被授权使用此机器人，请联系管理员添加。';

export function helpText(): string {
  return [
    '可用命令:',
    '/new — 重置会话（中止当前回合并开启全新会话）',
    '/stop — 停止当前进行中的回合',
    '/status — 查看网关状态（仅管理员私聊）',
    '/help — 显示本帮助',
    '',
    '普通消息直接发送即可对话；群聊中请 @我。',
  ].join('\n');
}

/** enter_chat 欢迎语 = 欢迎 + 命令清单（AC4：welcome + command list）。 */
export function welcomeText(): string {
  return `👋 你好！我是智能助手。\n\n${helpText()}`;
}

export function statusText(snap: { connected: boolean; authenticated: boolean; admins: readonly string[]; approved: readonly string[]; groups: readonly string[]; activeSessions: number; inFlight: number }): string {
  const conn = snap.connected ? (snap.authenticated ? '已连接（已认证）' : '已连接（未认证）') : '未连接';
  return [
    '📊 网关状态（快照）',
    `连接：${conn}`,
    `管理员 (${snap.admins.length}): ${snap.admins.join(', ') || '（无）'}`,
    `授权用户 (${snap.approved.length}): ${snap.approved.join(', ') || '（无）'}`,
    `授权群 (${snap.groups.length}): ${snap.groups.join(', ') || '（无）'}`,
    `活跃会话: ${snap.activeSessions}`,
    `进行中回合: ${snap.inFlight}`,
  ].join('\n');
}
```

- [ ] **Step 4: Run it and verify it PASSES** — Run: `bun test tests/unit/commands.test.ts` Expected: PASS（3 tests）
- [ ] **Step 5: Commit** — `git add src/commands.ts tests/unit/commands.test.ts && git commit -m "W3: command parsing, mention stripping with token boundary, user-facing copy"`

### Task 3: config.ts 增 `groupMentionName` 键

**Files:**
- Modify: `src/config.ts`（BotConfig 接口 + parseConfig 尾部）
- Test: `tests/unit/config.test.ts`（追加）

**Interfaces:**
- Consumes: 无
- Produces: `BotConfig.groupMentionName?: string`（trim 后非空；非法 ⇒ ConfigError）

- [ ] **Step 1: Write the failing test**（追加进 `tests/unit/config.test.ts`）

```ts
test('groupMentionName：合法字符串 trim 后生效；非字符串/空白 ⇒ ConfigError；缺省 undefined', () => {
  const mk = (json: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-cfg-gm-'));
    mkdirSync(join(dir, '.bot'), { recursive: true });
    writeFileSync(join(dir, '.bot', 'config.json'), json);
    return parseConfig(readFileSync(join(dir, '.bot', 'config.json'), 'utf8'), 'config.json');
  };
  expect(mk('{"logLevel":"info","groupMentionName":" 小助手 "}').groupMentionName).toBe('小助手');
  expect(mk('{}').groupMentionName).toBeUndefined();
  expect(() => mk('{"groupMentionName": 1}')).toThrow(ConfigError);
  expect(() => mk('{"groupMentionName":"  "}')).toThrow(ConfigError);
});
```

（文件头部已 import `parseConfig`/`ConfigError` 的测试件沿用其既有 import；无则补 `import { parseConfig, ConfigError } from '../../src/config';`）

- [ ] **Step 2: Run it and verify it FAILS** — Run: `bun test tests/unit/config.test.ts` Expected: FAIL（`groupMentionName` 不在 BotConfig——类型错/断言 undefined 失败）
- [ ] **Step 3: Write the minimal implementation**

`src/config.ts` BotConfig 接口追加：

```ts
  /** W3：群 @-提及匹配名（D3——真实平台 @ 文案内嵌 content，SDK 无 mention 字段）；
   *  groups 非空时必填（启动交叉校验在 createGateway——config 不读 access.json） */
  groupMentionName?: string;
```

parseConfig 尾部（`claudeModel` 块之后）追加：

```ts
  const mention = raw['groupMentionName'];
  if (mention !== undefined) {
    if (typeof mention !== 'string' || mention.trim() === '') {
      throw new ConfigError(`groupMentionName must be a non-empty string in ${path}`);
    }
    cfg.groupMentionName = mention.trim();
  }
```

- [ ] **Step 4: Run it and verify it PASSES** — Run: `bun test tests/unit/config.test.ts` Expected: PASS（含既有全部）
- [ ] **Step 5: Commit** — `git add src/config.ts tests/unit/config.test.ts && git commit -m "W3: groupMentionName config key (strict non-empty string)"`

## Checkpoint A（Tasks 1–3 后）

- [ ] `bun run typecheck` 通过
- [ ] `bun test tests/unit/access.test.ts tests/unit/commands.test.ts tests/unit/config.test.ts` 全绿
- [ ] `bun test`（全量）不回归——W1/W2 既有测试保持绿

### Task 4: transport 事件面扩展 — enterChat/feedbackEvent + replyWelcome + connectionStatus

**Files:**
- Modify: `src/transport/types.ts`（事件联合 + 接口）
- Modify: `src/transport/wecom-sdk-adapter.ts`（订阅 + replyWelcome + authenticated 跟踪）
- Modify: `tests/helpers/mock-wecom-server.ts`（pushEnterChat/pushFeedbackEvent/welcomeFrames）
- Modify: `tests/unit/agent-handler.test.ts`（**同 commit 迁移 FakeTransport**——接口扩员即时补桩，防 Checkpoint B 红灯，plan 评审 R2-F2）
- Test: `tests/integration/transport.test.ts`（追加）

**Interfaces:**
- Consumes: SDK `client.replyWelcome(frame, body)`（5s 窗）
- Produces:
  - `export interface InboundEnterChat { msgid: string; chatType: 'single' | 'group'; chatId?: string; userId: string; replyTo: ReplyRef }`
  - `export interface InboundFeedbackEvent { msgid: string; chatType: 'single' | 'group'; chatId?: string; userId: string }`
  - `TransportEvent` 增 `| { type: 'enterChat'; message: InboundEnterChat } | { type: 'feedbackEvent'; message: InboundFeedbackEvent }`
  - `WeComTransport` 增 `replyWelcome(ref: ReplyRef, content: string): Promise<void>` 与 `connectionStatus(): { connected: boolean; authenticated: boolean }`（plan 评审 R1-F3：/status 的已声明依赖——adapter 内部跟踪 authenticated 标志，'authenticated' 事件置 true、disconnected/teardown 置 false）
  - Mock: `pushEnterChat(reqId, msg)`、`pushFeedbackEvent(reqId, msg)`、`welcomeFrames: MockFrame[]`

- [ ] **Step 1: Write the failing test**（追加进 `tests/integration/transport.test.ts`，沿用该文件既有 transport 装配模式）

```ts
test('W3：enterChat/feedbackEvent 事件到达 handler；replyWelcome 走 aibot_respond_welcome_msg；connectionStatus 双字段', async () => {
  const srv = new MockWecomServer();
  const { url } = await srv.start();
  const t = new WecomSdkTransport({ botId: 'b', secret: 's', wsUrl: url, ...FAST });
  const rec = recorder();
  t.on(rec.push);
  await t.start();
  expect(t.connectionStatus()).toEqual({ connected: true, authenticated: true });
  const t0 = Date.now();
  srv.pushEnterChat('req-ec1', { msgid: 'ec1', userId: 'u9' });
  srv.pushFeedbackEvent('req-fb1', { msgid: 'fb1', userId: 'u9' });
  await new Promise((r) => setTimeout(r, 300));
  const ec = rec.events.find((e) => e.type === 'enterChat') as { type: 'enterChat'; message: InboundEnterChat } | undefined;
  expect(ec).toBeDefined();
  expect(ec!.message.userId).toBe('u9');
  expect(ec!.message.chatType).toBe('single');
  expect(ec!.message.replyTo.reqId).toBe('req-ec1');
  expect(rec.events.some((e) => e.type === 'feedbackEvent')).toBe(true);
  await t.replyWelcome(ec!.message.replyTo, '欢迎');
  expect(srv.welcomeFrames.length).toBe(1);
  expect((srv.welcomeFrames[0]!.body as { text?: { content?: string } }).text?.content).toBe('欢迎');
  expect(Date.now() - t0).toBeLessThan(5_000);
  // R3-F3：平台拒绝（errcode≠0）⇒ replyWelcome reject（handler 的 ERROR 审计依赖此契约）
  srv.welcomeErrcode = 40097;
  await expect(t.replyWelcome(ec!.message.replyTo, '再发一次')).rejects.toThrow(/errcode=40097/);
  srv.welcomeErrcode = 0;
  await t.stop();
  expect(t.connectionStatus()).toEqual({ connected: false, authenticated: false });
  await srv.stop();
});
```

（import 区补 `import type { InboundEnterChat } from '../../src/transport/types';`）

- [ ] **Step 2: Run it and verify it FAILS** — Run: `bun test tests/integration/transport.test.ts` Expected: FAIL（类型/方法不存在——typecheck 亦红）
- [ ] **Step 3: Write the minimal implementation**

`src/transport/types.ts` 追加（`InboundTextMessage` 之后）：

```ts
export interface InboundEnterChat {
  msgid: string;
  chatType: 'single' | 'group';
  chatId?: string;
  userId: string;
  replyTo: ReplyRef;
}

export interface InboundFeedbackEvent {
  msgid: string;
  chatType: 'single' | 'group';
  chatId?: string;
  userId: string;
}
```

`TransportEvent` 联合追加两员；`WeComTransport` 接口追加：

```ts
  replyWelcome(ref: ReplyRef, content: string): Promise<void>;
  connectionStatus(): { connected: boolean; authenticated: boolean };
```

`src/transport/wecom-sdk-adapter.ts`——类字段追加 `private authenticatedFlag = false;`；`'authenticated'` 监听内置 `this.authenticatedFlag = true;`；`'disconnected'` 监听内置 `this.authenticatedFlag = false;`；`teardownClient()` 开头置 `this.authenticatedFlag = false;`。`event.disconnected_event` 订阅块旁追加：

```ts
      client.on('event.enter_chat', (frame: WsFrame) => {
        const body = frame.body as unknown as { msgid: string; chattype?: 'single' | 'group'; chatid?: string; from: { userid: string } };
        this.emit({
          type: 'enterChat',
          message: {
            msgid: body.msgid,
            chatType: body.chattype ?? 'single',
            ...(body.chattype === 'group' && body.chatid ? { chatId: body.chatid } : {}),
            userId: body.from?.userid ?? 'unknown',
            replyTo: refFromFrame(frame),
          },
        });
      });
      client.on('event.feedback_event', (frame: WsFrame) => {
        const body = frame.body as unknown as { msgid: string; chattype?: 'single' | 'group'; chatid?: string; from: { userid: string } };
        this.emit({
          type: 'feedbackEvent',
          message: { msgid: body.msgid, chatType: body.chattype ?? 'single', ...(body.chattype === 'group' && body.chatid ? { chatId: body.chatid } : {}), userId: body.from?.userid ?? 'unknown' },
        });
      });
```

`replyStream` 方法旁追加：

```ts
  async replyWelcome(ref: ReplyRef, content: string): Promise<void> {
    if (!this.client) throw new Error('transport not started');
    const frame: WsFrameHeaders = { headers: { req_id: ref.reqId } };
    const receipt = await this.client.replyWelcome(frame, { msgtype: 'text', text: { content } });
    if (receipt.errcode !== undefined && receipt.errcode !== 0) {
      throw new Error(`replyWelcome rejected: errcode=${receipt.errcode} errmsg=${receipt.errmsg}`);
    }
  }

  connectionStatus(): { connected: boolean; authenticated: boolean } {
    return { connected: this.isConnected(), authenticated: this.authenticatedFlag };
  }
```

`tests/helpers/mock-wecom-server.ts` 追加（`sentFrames` 旁）：

```ts
  welcomeFrames: MockFrame[] = [];
  /** R3-F3：welcome 回执错误模式——非 0 时对 aibot_respond_welcome_msg 回 errcode（测 adapter 拒绝路径） */
  welcomeErrcode = 0;

  pushEnterChat(reqId: string, msg: { msgid: string; userId: string; chatType?: 'single' | 'group'; chatid?: string }): void {
    this.broadcast({
      cmd: 'aibot_event_callback',
      headers: { req_id: reqId },
      body: {
        msgid: msg.msgid, aibotid: 'bot-mock', chattype: msg.chatType ?? 'single',
        ...(msg.chatType === 'group' && msg.chatid ? { chatid: msg.chatid } : {}),
        from: { userid: msg.userId }, msgtype: 'event', event: { eventtype: 'enter_chat' },
        create_time: Math.floor(Date.now() / 1000),
      },
    });
  }

  pushFeedbackEvent(reqId: string, msg: { msgid: string; userId: string; chatType?: 'single' | 'group'; chatid?: string }): void {
    this.broadcast({
      cmd: 'aibot_event_callback',
      headers: { req_id: reqId },
      body: {
        msgid: msg.msgid, aibotid: 'bot-mock', chattype: msg.chatType ?? 'single',
        ...(msg.chatType === 'group' && msg.chatid ? { chatid: msg.chatid } : {}),
        from: { userid: msg.userId }, msgtype: 'event', event: { eventtype: 'feedback_event' },
      },
    });
  }
```

消息处理分支追加（`aibot_respond_msg` 记账旁）：

```ts
        if (frame.cmd === 'aibot_respond_welcome_msg') {
          this.welcomeFrames.push(frame);
          if (this.welcomeErrcode !== 0) {
            ws.send(JSON.stringify({ headers: { req_id: frame.headers.req_id }, errcode: this.welcomeErrcode, errmsg: 'welcome rejected' }));
            return;
          }
        }
```

`tests/unit/agent-handler.test.ts` 的 FakeTransport **同 commit** 补桩（R2-F2——WeComTransport 接口扩员后该 fake 立即失型）：

```ts
// FakeTransport 追加：
  welcomes: Array<{ reqId: string; content: string }> = [];
  welcomeImpl: (content: string) => Promise<void> = async () => undefined;
  async replyWelcome(ref: ReplyRef, content: string) { this.welcomes.push({ reqId: ref.reqId, content }); await this.welcomeImpl(content); }
  connectionStatus() { return { connected: true, authenticated: true }; }
```

- [ ] **Step 4: Run it and verify it PASSES** — Run: `bun test tests/integration/transport.test.ts && bun run typecheck` Expected: PASS（typecheck 含 agent-handler fake 迁移）
- [ ] **Step 5: Commit** — `git add src/transport/types.ts src/transport/wecom-sdk-adapter.ts tests/helpers/mock-wecom-server.ts tests/unit/agent-handler.test.ts tests/integration/transport.test.ts && git commit -m "W3: transport enterChat/feedbackEvent events, replyWelcome (5s window), connectionStatus + fake migration"`

### Task 5: manager.abortChat + 会话/并发计数面

**Files:**
- Modify: `src/agent/manager.ts`（常量/哨兵区、submit 后新增公开方法、EOF 失败路径哨兵链）
- Modify: `src/agent/session-store.ts`（listActive）
- Test: `tests/unit/manager.test.ts`（追加）

**Interfaces:**
- Consumes: 既有 `terminateChild`/哨兵模式/`busy`/`queues`/`pendingAsks`
- Produces:
  - `export const TURN_ABORTED_ERROR = 'turn aborted by user command'`
  - `AgentManager.abortChat(chatKey: string): { status: 'stopped' | 'stopping' | 'idle'; dropped: number }`（plan 评审 R1-F4：`'stopping'` = 已在收割中的回合——双击 /stop 不得误报 idle）
  - `AgentManager.resetSession(chatKey: string): void`
  - `AgentManager.inFlightCount(): number`
  - `AgentManager.activeSessionCount(): number`
  - `SessionStore.listActive(): number`

- [ ] **Step 1: Write the failing test**（追加进 `tests/unit/manager.test.ts`）

```ts
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
```

（文件头 import 补 `TURN_ABORTED_ERROR`：`import { AgentManager, TURN_TIMEOUT_ERROR, TURN_ABORTED_ERROR, type AgentEvent } from '../../src/agent/manager';`）

- [ ] **Step 2: Run it and verify it FAILS** — Run: `bun test tests/unit/manager.test.ts` Expected: FAIL（TURN_ABORTED_ERROR 未导出 / abortChat 不是函数）
- [ ] **Step 3: Write the minimal implementation**

`src/agent/manager.ts`——常量区（`TURN_TIMEOUT_ERROR` 旁）：

```ts
export const TURN_ABORTED_ERROR = 'turn aborted by user command';
```

哨兵区（`expiredAskProcs` 旁）：

```ts
const abortedProcs = new WeakSet<ChildProcess>();    // /stop //new 用户中止哨兵（EOF 路径据此发中止终态）
```

公开方法（`submit` 之后）：

```ts
  /** 用户命令中止（/stop /new）：drop 该 chat 队列 + 定向杀在跑回合（代际检查）。
   *  status 三态（plan 评审 R1-F4）：'stopped' 本次击杀 / 'stopping' 已在收割中（双击）/
   *  'idle' 无在跑回合。清理与槽位释放仍归 runTurnInner（唯一所有者——abortDyingTurn 同契约）；
   *  EOF 失败路径按 abortedProcs 哨兵发 turn_failed(TURN_ABORTED_ERROR)——中止终帧即 clean stream close（D4）。 */
  abortChat(chatKey: string): { status: 'stopped' | 'stopping' | 'idle'; dropped: number } {
    const q = this.queues.get(chatKey);
    const dropped = q ? q.length : 0;
    this.queues.delete(chatKey);
    const turn = this.busy.get(chatKey);
    if (!turn) return { status: 'idle', dropped };
    if (turn.terminating) return { status: 'stopping', dropped };
    if (turn.deadline) clearTimeout(turn.deadline);
    if (turn.askDeadline) clearTimeout(turn.askDeadline);
    if (this.pendingAsks.get(chatKey)?.proc === turn.proc) this.pendingAsks.delete(chatKey);
    turn.terminating = true;
    abortedProcs.add(turn.proc);
    try { turn.proc.kill('SIGINT'); } catch { /* 已退 */ }
    void terminateChild(turn.proc, this.opts.reapEofMs, this.opts.reapTermMs);
    return { status: 'stopped', dropped };
  }

  /** /new 的会话档闭锁（无档 no-op）——下一条消息 resumable() 即 fresh。 */
  resetSession(chatKey: string): void {
    this.deps.sessions.close(chatKey);
  }

  /** /status 数据面（D6）。 */
  inFlightCount(): number { return this.busy.size; }

  activeSessionCount(): number { return this.deps.sessions.listActive(); }
```

EOF 失败路径（`if (!turnFinished) {` 块内，`expiredAskProcs` 判定**之前**插入，原链改为 `else if` 衔接）：

```ts
      if (abortedProcs.has(proc)) {
        // 用户命令中止（D4）：中止终帧即 /stop 的 clean stream close——先于其他哨兵判定
        await onEvent({ type: 'turn_failed', chatKey, error: TURN_ABORTED_ERROR });
      } else if (expiredAskProcs.has(proc)) {
```

`src/agent/session-store.ts` 追加（`close` 旁；import 区补 `readdirSync`）：

```ts
  /** /status 数据面：活动档计数（读目录 + 逐档 status 判定——记录极小，W2 D4 无启动清扫同因）。 */
  listActive(): number {
    let n = 0;
    for (const f of readdirSync(this.sessionsDir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const s = JSON.parse(readFileSync(join(this.sessionsDir, f), 'utf8')) as ChatSession;
        if (s && s.status === 'active') n += 1;
      } catch { /* 坏档不计数（get 同款严格丢语义） */ }
    }
    return n;
  }
```

- [ ] **Step 4: Run it and verify it PASSES** — Run: `bun test tests/unit/manager.test.ts` Expected: PASS（含既有全部——超时/ask 过期哨兵路径不回归）
- [ ] **Step 5: Commit** — `git add src/agent/manager.ts src/agent/session-store.ts tests/unit/manager.test.ts && git commit -m "W3: manager abortChat (stopped/stopping/idle tri-state, sentinel kill), resetSession, status counters"`

## Checkpoint B（Tasks 4–5 后）

- [ ] `bun run typecheck` 通过（types.ts 扩员后无类型漂移）
- [ ] `bun test`（全量）通过——W2 的超时/ask 过期/收割测试不受新哨兵影响

### Task 6: AgentHandler 分派集成 + createGateway 接线（gate / 命令 / welcome / feedback）

**Files:**
- Modify: `src/handlers/agent.ts`（AgentManagerPort 增员、userFacingError、deps 增员、register 事件分流、onText 头部 gate+命令分派、dispatchCommand、onEnterChat）
- Modify: `src/gateway.ts`（createGateway 装配——**与 handler 改动同 commit**，plan 评审 R3-F2：access 必填后 gateway 构造即时接线，否则本 commit typecheck 红）
- Modify: `tests/integration/agent.test.ts`（setup() 补写 approved access.json——**空 access 下 W2 的 u1 全变陌生人，12 处 pushTextMessage 全体回归**，同样 commit）
- Test: `tests/unit/agent-handler.test.ts`（追加新测试 + **既有 makeHandler fixture 同 commit 迁移**——R2-F2/R3-F2：access 成为必填依赖，W2 桥接测试的装配同步改造，Task 6 commit 自身保绿）

**Interfaces:**
- Consumes: Task 1 `AccessGate`/`AccessSnapshot`；Task 2 `parseCommand`/`stripMention`/`helpText`/`welcomeText`/`statusText`/`REJECTION_TEXT`/`ParsedCommand`；Task 4 `InboundEnterChat`/`connectionStatus`；Task 5 `abortChat`/`resetSession`/`inFlightCount`/`activeSessionCount`/`TURN_ABORTED_ERROR`
- Produces:
  - handler deps 增 `access: AccessGate; mentionName?: string`
  - `AgentManagerPort` 增 `abortChat(chatKey: string): { status: 'stopped' | 'stopping' | 'idle'; dropped: number }`、`resetSession(chatKey: string): void`、`inFlightCount(): number`、`activeSessionCount(): number`

- [ ] **Step 1: Write the failing test**（追加进 `tests/unit/agent-handler.test.ts`；先给 FakeTransport 补 `welcomes`、FakeManager 补新方法——见 Step 3 桩说明）

```ts
import { writeFileSync } from 'node:fs';   // 追加到既有 import 区（mkdirSync/mkdtempSync 已有）
import { AccessGate } from '../../src/access';

function makeGatedHandler(accessJson: unknown, mentionName?: string, manager = new FakeManager()) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-gate-'));
  mkdirSync(join(dir, 'logs'), { recursive: true });
  writeFileSync(join(dir, 'access.json'), JSON.stringify(accessJson) + '\n');
  const access = new AccessGate(join(dir, 'access.json'));
  const transport = new FakeTransport();
  const logger = new BotLogger({ level: 'debug', logDir: join(dir, 'logs'), console: false });
  const handler = new AgentHandler({ transport, logger, manager, workspace: dir, access, ...(mentionName !== undefined ? { mentionName } : {}) }, { refreshIntervalMs: 10 });
  return { handler, transport, manager, dir, access };
}

test('W3 gate：陌生人 p2p 得拒绝文案、不 submit；rejected 同文案；approved 放行', async () => {
  const { handler, transport, manager } = makeGatedHandler({ approved: ['u1'], rejected: ['bad'] });
  handler.register();
  transport.emit(MSG({ userId: 'stranger', content: '/help' })); // 陌生人的命令也只得到拒绝
  await flush();
  expect(transport.sent.at(-1)!.content).toContain('未被授权');
  transport.emit(MSG({ userId: 'bad', content: '你好' }));       // rejected 与 unknown 同文案
  await flush();
  expect(transport.sent.at(-1)!.content).toContain('未被授权');
  expect(manager.submitted.length).toBe(0);
  transport.emit(MSG()); // u1 approved
  await flush();
  expect(manager.submitted.length).toBe(1);
});

test('W3 AC1：四命令分派——均不 submit；未知命令 → 帮助文案', async () => {
  const { handler, transport, manager } = makeGatedHandler({ admin: ['u1'] });
  handler.register();
  for (const c of ['/help', '/status', '/new', '/stop', '/frobnicate']) {
    transport.emit(MSG({ content: c }));
    await flush();
  }
  expect(manager.submitted.length).toBe(0);
  const texts = transport.sent.map((f) => f.content).join('\n--\n');
  expect(texts).toContain('/new');                    // help
  expect(texts).toContain('网关状态');                 // status（admin）
  expect(texts).toContain('已重置会话');               // new
  expect(texts).toContain('当前没有进行中的回合');       // stop（idle）
  expect(texts).toContain('未知命令：/frobnicate');     // unknown → help
  expect(manager.resets.length).toBe(1);              // new 闭档
});

test('W3 /status：approved 用户与群内均拒答（不披露 roster）', async () => {
  const { handler, transport } = makeGatedHandler({ admin: ['boss'], approved: ['u1'], groups: ['g1'] }, '小助手');
  handler.register();
  transport.emit(MSG({ content: '/status' })); // u1 = approved（p2p）
  await flush();
  expect(transport.sent.at(-1)!.content).toContain('仅管理员');
  expect(transport.sent.at(-1)!.content).not.toContain('boss'); // 无 roster 泄露
  transport.emit(MSG({ chatType: 'group', chatId: 'g1', userId: 'boss', content: '@小助手 /status' })); // admin 在群里也拒
  await flush();
  expect(transport.sent.at(-1)!.content).toContain('仅管理员');
  expect(transport.sent.at(-1)!.content).not.toContain('boss');
});

test('W3 /stop：stopped/stopping 不发 idle 提示（回执由中止终帧承载）；idle+dropped 提示清空数', async () => {
  const manager = new FakeManager();
  manager.abortStatus = 'stopped';
  const { handler, transport } = makeGatedHandler({ approved: ['u1'] }, undefined, manager);
  handler.register();
  transport.emit(MSG({ content: '/stop' }));
  await flush();
  expect(manager.aborts.length).toBe(1);
  expect(transport.sent.filter((f) => f.content.includes('当前没有进行中的回合')).length).toBe(0); // 无 idle 误报
  manager.abortStatus = 'stopping'; // 双击
  transport.emit(MSG({ content: '/stop' }));
  await flush();
  expect(transport.sent.filter((f) => f.content.includes('当前没有进行中的回合')).length).toBe(0);
  manager.abortStatus = 'idle'; manager.abortDropped = 2;
  transport.emit(MSG({ content: '/stop' }));
  await flush();
  expect(transport.sent.at(-1)!.content).toContain('已清空 2 条排队消息');
});

test('W3 abort 文案映射：turn_failed(aborted) → 「已停止当前回合」', async () => {
  const { handler, transport, manager } = makeGatedHandler({ approved: ['u1'] });
  handler.register();
  transport.emit(MSG()); // 起回合（FakeManager started）
  await flush();
  manager.nextEvents.push((emit) => emit({ type: 'turn_failed', chatKey: 'single:u1', error: 'turn aborted by user command' }));
  await flush();
  expect(transport.sent.at(-1)!.content).toContain('已停止当前回合');
});

test('W3 命令先于 pending-ask：pending ask 期间的 /stop 中止而非作答', async () => {
  const manager = new FakeManager();
  manager.pendingFlag = true;
  const { handler, transport } = makeGatedHandler({ approved: ['u1'] }, undefined, manager);
  handler.register();
  transport.emit(MSG({ content: '/stop' }));
  await flush();
  expect(manager.aborts.length).toBe(1);
  expect(manager.answers.length).toBe(0); // 未消费 ask
});

test('W3 群策略：allowlist+@+剥离进 agent；未 listed 群/rejected/无 @/冒名前缀 忽略', async () => {
  const { handler, transport, manager } = makeGatedHandler({ approved: ['u1'], rejected: ['bad'], groups: ['g1'] }, '小助手');
  handler.register();
  transport.emit(MSG({ chatType: 'group', chatId: 'g1', userId: 'u1', content: '@小助手 群里好' }));
  await flush();
  expect(manager.submitted.at(-1)!.prompt).toContain('群里好');
  expect(manager.submitted.at(-1)!.chatKey).toBe('group:g1');
  const before = manager.submitted.length;
  transport.emit(MSG({ chatType: 'group', chatId: 'g2', userId: 'u1', content: '@小助手 未授权群' })); // 非 listed 群
  transport.emit(MSG({ chatType: 'group', chatId: 'g1', userId: 'bad', content: '@小助手 被拒者' }));   // rejected
  transport.emit(MSG({ chatType: 'group', chatId: 'g1', userId: 'u1', content: '没有@' }));            // 无提及
  transport.emit(MSG({ chatType: 'group', chatId: 'g1', userId: 'u1', content: '@小助手2 冒名' }));     // token 边界
  await flush();
  expect(manager.submitted.length).toBe(before);
});

test('W3 群命令：@bot /stop 在群内分派（群会话可停）', async () => {
  const manager = new FakeManager();
  manager.abortStatus = 'idle'; manager.abortDropped = 2;
  const { handler, transport } = makeGatedHandler({ groups: ['g1'] }, '小助手', manager);
  handler.register();
  transport.emit(MSG({ chatType: 'group', chatId: 'g1', userId: 'anyone', content: '@小助手 /stop' }));
  await flush();
  expect(manager.aborts.length).toBe(1);
  expect(transport.sent.at(-1)!.content).toContain('已清空 2 条排队消息');
});

test('W3 AC4 welcome：allowed→欢迎+命令清单；unknown→拒绝文案；同步调用（零前置 await）；群 enter_chat 忽略', async () => {
  const { handler, transport } = makeGatedHandler({ approved: ['u1'] });
  handler.register();
  transport.emit({ type: 'enterChat', message: { msgid: 'e1', chatType: 'single', userId: 'u1', replyTo: { __brand: 'ReplyRef', reqId: 'r-ec' } } });
  expect(transport.welcomes.length).toBe(1); // 同步 tick 内已发起——5s 窗硬路径（D5）
  expect(transport.welcomes[0]!.content).toContain('/help');
  transport.emit({ type: 'enterChat', message: { msgid: 'e2', chatType: 'single', userId: 'stranger', replyTo: { __brand: 'ReplyRef', reqId: 'r-ec2' } } });
  expect(transport.welcomes[1]!.content).toContain('未被授权');
  transport.emit({ type: 'enterChat', message: { msgid: 'e3', chatType: 'group', chatId: 'g1', userId: 'u1', replyTo: { __brand: 'ReplyRef', reqId: 'r-ec3' } } });
  expect(transport.welcomes.length).toBe(2); // 群 enter_chat 忽略
});

test('W3 feedback_event：仅日志，无任何回执', async () => {
  const { handler, transport } = makeGatedHandler({ approved: ['u1'] });
  handler.register();
  transport.emit({ type: 'feedbackEvent', message: { msgid: 'f1', chatType: 'single', userId: 'u1' } });
  await flush();
  expect(transport.sent.length).toBe(0);
  expect(transport.welcomes.length).toBe(0);
});

/** R2-F5：日志契约可验证——读 logger JSONL 日文件断言条目（内容不得入日志）。 */
import { readFileSync } from 'node:fs';
const logLines = (dir: string): Array<Record<string, unknown>> =>
  readFileSync(join(dir, 'logs', `gateway-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.jsonl`), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);

test('W3 日志契约（R2-F5）：feedback/拒绝入日志但不记内容；welcome 失败 ERROR 留痕', async () => {
  const { handler, transport, dir } = makeGatedHandler({ approved: ['u1'] });
  handler.register();
  transport.emit({ type: 'feedbackEvent', message: { msgid: 'f1', chatType: 'single', userId: 'u1' } });
  await flush();
  const fb = logLines(dir).find((l) => l['event'] === 'feedback event')!;
  expect(fb['msgid']).toBe('f1');
  expect(JSON.stringify(fb)).not.toContain('消息内容'); // 无内容字段面
  transport.emit(MSG({ userId: 'stranger', content: '秘密内容xyz' }));
  await flush();
  const rej = logLines(dir).find((l) => l['event'] === 'p2p sender not authorized')!;
  expect(JSON.stringify(rej)).not.toContain('秘密内容xyz'); // 拒绝日志不记内容（D8）
  transport.welcomeImpl = async () => { throw new Error('5s window passed'); };
  transport.emit({ type: 'enterChat', message: { msgid: 'e9', chatType: 'single', userId: 'u1', replyTo: { __brand: 'ReplyRef', reqId: 'r-e9' } } });
  await flush();
  expect(logLines(dir).some((l) => l['event'] === 'welcome reply failed' && l['level'] === 'error')).toBe(true);
});
```

- [ ] **Step 2: Run it and verify it FAILS** — Run: `bun test tests/unit/agent-handler.test.ts` Expected: FAIL（AgentHandler deps 无 access——构造类型错）
- [ ] **Step 3: Write the minimal implementation**

测试桩增员与 fixture 迁移（`tests/unit/agent-handler.test.ts`）——FakeTransport 的 welcome/connectionStatus 桩已在 Task 4 落盘，本任务补：

```ts
// FakeManager 追加：
  aborts: string[] = [];
  resets: string[] = [];
  abortStatus: 'stopped' | 'stopping' | 'idle' = 'idle';
  abortDropped = 0;
  abortChat(chatKey: string) { this.aborts.push(chatKey); return { status: this.abortStatus, dropped: this.abortDropped }; }
  resetSession(chatKey: string) { this.resets.push(chatKey); }
  inFlightCount() { return 0; }
  activeSessionCount() { return 0; }
```

既有 `makeHandler`（W2 桥接测试装配）**同 commit 迁移**（R2-F2——access 必填后装配改造，W2 测试断言不动）：

```ts
function makeHandler(manager = new FakeManager(), opts: { onReplyError?: (e: Error) => void } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-hdl-'));
  mkdirSync(join(dir, 'logs'), { recursive: true });
  writeFileSync(join(dir, 'access.json'), JSON.stringify({ admin: ['u1'] }) + '\n'); // W2 默认 userId=u1 全放行
  const access = new AccessGate(join(dir, 'access.json'));
  // …transport/logger 原样…
  const handler = new AgentHandler({ transport, logger, manager, workspace: dir, access }, { refreshIntervalMs: 10, ...opts });
  // …返回原样…
}
```

`src/handlers/agent.ts`——import 区追加：

```ts
import type { AccessGate, AccessSnapshot } from '../access';
import { parseCommand, stripMention, helpText, welcomeText, statusText, REJECTION_TEXT, type ParsedCommand } from '../commands';
import { TURN_ABORTED_ERROR } from '../agent/manager';
```

（import 区已有 `InboundTextMessage`——补 `InboundEnterChat`。）

`AgentManagerPort` 接口追加四员（签名同 Task 5 Produces）。deps 类型追加 `access: AccessGate; mentionName?: string`。

`userFacingError` 首行追加映射：

```ts
  if (error === TURN_ABORTED_ERROR) return '⏹ 已停止当前回合';
```

`register()` 事件分流（现有 `if (event.type !== 'textMessage') return;` 替换）：

```ts
    this.deps.transport.on((event) => {
      if (event.type === 'enterChat') {
        // 5s 硬路径（D5）：分层欢迎——同步 tier 判定后立即 replyWelcome，无前置 await
        this.onEnterChat(event.message).catch((e: unknown) => {
          this.deps.logger.error('welcome handling failed', { msgid: event.message.msgid, err: (e as Error).message });
        });
        return;
      }
      if (event.type === 'feedbackEvent') {
        this.deps.logger.info('feedback event', { msgid: event.message.msgid, userId: event.message.userId, chatType: event.message.chatType });
        return;
      }
      if (event.type !== 'textMessage') return;
      // …既有 textMessage 处理不动
```

`onEnterChat`（新私有方法）：

```ts
  /** enter_chat 分层欢迎（D5）：allowed → 欢迎+命令清单；rejected/unknown → 拒绝文案；
   *  群 enter_chat 忽略。发送失败留痕不影响消息面。 */
  private async onEnterChat(m: InboundEnterChat): Promise<void> {
    if (m.chatType !== 'single') {
      this.deps.logger.debug('group enter_chat ignored', { msgid: m.msgid });
      return;
    }
    const snap = this.deps.access.load();
    const tier = snap.tierOf(m.userId);
    const content = tier === 'admin' || tier === 'approved' ? welcomeText() : REJECTION_TEXT;
    try {
      await this.deps.transport.replyWelcome(m.replyTo, content);
    } catch (e) {
      this.deps.logger.error('welcome reply failed', { msgid: m.msgid, userId: m.userId, err: (e as Error).message });
    }
  }
```

`onText` 头部（群帧守卫之后、`chatKeyOf` 之后插入 gate 与命令分派；既有 pending-ask/submit 段中 `m.content` 全部改用剥离后的 `content`）：

```ts
  private async onText(m: InboundTextMessage): Promise<void> {
    if (m.chatType === 'group' && !m.chatId) {
      this.deps.logger.debug('group text without chatId ignored', { msgid: m.msgid });
      return;
    }
    const chatKey = chatKeyOf(m);
    // 单帧单快照（plan 评审 R1-F2）：本帧全部判定共用同一 access 版本
    const snap = this.deps.access.load();
    let content = m.content;
    if (m.chatType === 'group') {
      // 群策略（D2/D3）：allowlist → rejected 静默 → @ 提及 token 边界匹配剥离
      if (!snap.groupAllowed(m.chatId!)) {
        this.deps.logger.debug('group not allow-listed, ignored', { msgid: m.msgid, chatId: m.chatId });
        return;
      }
      const tier = snap.tierOf(m.userId);
      if (tier === 'rejected') {
        this.deps.logger.warn('rejected sender in group ignored', { msgid: m.msgid, userId: m.userId });
        return;
      }
      const stripped = stripMention(m.content, this.deps.mentionName);
      if (stripped === null) {
        this.deps.logger.debug('group text without bot mention ignored', { msgid: m.msgid });
        return;
      }
      content = stripped;
      if (content.trim() === '') return;
    } else {
      const tier = snap.tierOf(m.userId);
      if (tier !== 'admin' && tier !== 'approved') {
        this.deps.logger.info('p2p sender not authorized', { msgid: m.msgid, userId: m.userId });
        await this.notice(m.replyTo, chatKey, REJECTION_TEXT);
        return;
      }
    }
    const cmd = parseCommand(content);
    if (cmd) {
      await this.dispatchCommand(cmd, m, chatKey, snap);
      return;
    }
    // ↓ 既有 pending-ask 过期/作答段与 submit 段（m.content → content；prompt 前导不变）
```

`dispatchCommand`（新私有方法——快照随帧透传，/status 授权与名单同版本）：

```ts
  /** 网关命令分派（D4/D6/D9/D10）——已过 gate；snap 为本帧 access 快照（R1-F2 同版本授权）。 */
  private async dispatchCommand(cmd: ParsedCommand, m: InboundTextMessage, chatKey: string, snap: AccessSnapshot): Promise<void> {
    this.deps.logger.info('command', { name: cmd.name, chatKey, userId: m.userId });
    switch (cmd.name) {
      case 'help':
        await this.notice(m.replyTo, chatKey, helpText());
        return;
      case 'new': {
        this.deps.manager.abortChat(chatKey);
        this.deps.manager.resetSession(chatKey);
        await this.notice(m.replyTo, chatKey, '🔄 已重置会话，下一条消息将开启全新对话。');
        return;
      }
      case 'stop': {
        const r = this.deps.manager.abortChat(chatKey);
        if (r.status === 'idle') {
          // stopped/stopping：不另发 ack——中止终帧（turn_failed→「已停止当前回合」）即回执（D4）
          await this.notice(m.replyTo, chatKey, r.dropped > 0 ? `已清空 ${r.dropped} 条排队消息；当前没有进行中的回合` : '当前没有进行中的回合');
        }
        return;
      }
      case 'status': {
        if (m.chatType !== 'single' || snap.tierOf(m.userId) !== 'admin') {
          await this.notice(m.replyTo, chatKey, '/status 仅管理员私聊可用。');
          return;
        }
        const conn = this.deps.transport.connectionStatus();
        await this.notice(m.replyTo, chatKey, statusText({
          connected: conn.connected, authenticated: conn.authenticated,
          admins: snap.admin, approved: snap.approved, groups: snap.groups,
          activeSessions: this.deps.manager.activeSessionCount(),
          inFlight: this.deps.manager.inFlightCount(),
        }));
        return;
      }
      default:
        await this.notice(m.replyTo, chatKey, `未知命令：/${cmd.name}\n\n${helpText()}`);
    }
  }
```

- [ ] **Step 4: Wire createGateway + 既有集成测试基线（同 commit，R3-F2）**

`src/gateway.ts` createGateway——SessionStore 构造之后：

```ts
  const access = new AccessGate(join(ws.botDir, 'access.json'), {
    onError: (e) => logger.error('access reload failed, using last-known-good', { err: e.message }),
  });
  // D3 启动交叉校验：配了群却配不出触发名 = 配置残缺（运行期 groups 热加而缺名 ⇒ 群帧全忽略 + debug——fail-safe）
  if (access.load().groups.length > 0 && !ws.config.groupMentionName) {
    throw new ConfigError(`access.json lists groups but config.json has no groupMentionName — group @-trigger cannot match (workspace: ${workspace})`);
  }
```

（import 区补 `import { AccessGate } from './access';`；`AgentHandler` 构造增 `access, ...(ws.config.groupMentionName ? { mentionName: ws.config.groupMentionName } : {})`。）

`agent.test.ts` 的 `setup()` 在写 `.env` 之后追加一行：

```ts
  writeFileSync(join(ws, '.bot', 'access.json'), JSON.stringify({ approved: ['u1'] }) + '\n');
```

- [ ] **Step 5: Run it and verify it PASSES（全量门）** — Run: `bun run typecheck && bun test` Expected: PASS（agent-handler 新旧用例、W2 集成 AC1–AC5 因 setup 补 approved 回绿、gateway 接线编译面全过）
- [ ] **Step 6: Commit** — `git add src/handlers/agent.ts src/gateway.ts tests/unit/agent-handler.test.ts tests/integration/agent.test.ts && git commit -m "W3: inbound gate (frame-scoped access snapshot, group policy, commands) + layered welcome + gateway wiring"`

### Task 7: 装配验证 — 启动交叉校验与 access 失败面（测试固化）

**Files:**
- Test: `tests/integration/agent.test.ts`（追加接线断言——实现已在 Task 6 落地，本任务是证据固化）

**Interfaces:**
- Consumes: Task 6 完整装配（AccessGate 注入 + 交叉校验）
- Produces: 启动面契约测试（`groups` 非空而 `groupMentionName` 缺失 ⇒ ConfigError；access 缺失/损坏 ⇒ AccessError(⊂ConfigError)）

- [ ] **Step 1: Write the tests**（追加进 `tests/integration/agent.test.ts`；文件头补 `import { ConfigError } from '../../src/config';`）

```ts
test('W3 接线：approved 用户 happy path 不回归（gate 放行进 agent）', async () => {
  const { srv, gateway } = await setup('happy'); // setup 已写 {approved:['u1']}（Task 6）
  srv.pushTextMessage('req-1', { msgid: 'm1', userId: 'u1', content: '你好' });
  await waitUntil(() => streamsOf(srv).some((s) => s.finish));
  expect(streamsOf(srv).at(-1)!.content).toContain('假回复');
  await gateway.stop(); await srv.stop();
});

test('W3 接线：groups 非空而 groupMentionName 缺失 ⇒ createGateway 抛 ConfigError', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'wb-xval-'));
  const { loadWorkspace } = await import('../../src/config');
  loadWorkspace(ws);
  writeFileSync(join(ws, '.bot', '.env'), 'WECOM_BOT_ID=b\nWECOM_SECRET=s\n');
  writeFileSync(join(ws, '.bot', 'access.json'), '{"groups":["g1"]}\n');
  const srv = new MockWecomServer();
  const { url } = await srv.start();
  let err: unknown;
  try { await createGateway(ws, { wsUrl: url }); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(ConfigError);
  expect((err as Error).message).toContain('groupMentionName');
  await srv.stop();
});

test('W3 接线：access.json 缺失/损坏 ⇒ createGateway 启动即抛 ConfigError（R2-F1/R3-F1——响亮失败面）', async () => {
  const { AccessError } = await import('../../src/access');
  const { ConfigError } = await import('../../src/config');
  for (const content of [null, 'garbage{']) {
    const ws = mkdtempSync(join(tmpdir(), 'wb-accfail-'));
    const { loadWorkspace } = await import('../../src/config');
    loadWorkspace(ws);
    writeFileSync(join(ws, '.bot', '.env'), 'WECOM_BOT_ID=b\nWECOM_SECRET=s\n');
    if (content !== null) writeFileSync(join(ws, '.bot', 'access.json'), content);
    // null ⇒ 删掉 loadWorkspace 建的 {} 占位，模拟缺失
    if (content === null) { const { rmSync } = await import('node:fs'); rmSync(join(ws, '.bot', 'access.json')); }
    const srv = new MockWecomServer();
    const { url } = await srv.start();
    let err: unknown;
    try { await createGateway(ws, { wsUrl: url }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(AccessError);
    expect(err).toBeInstanceOf(ConfigError); // R3-F1：与配置错误同契约（统一消费面）
    await srv.stop();
  }
});
```

- [ ] **Step 2: Run it and verify it PASSES** — Run: `bun test tests/integration/agent.test.ts` Expected: PASS（Task 6 实现已落——若红即装配缺口，回补实现而非改测试）
- [ ] **Step 3: Commit** — `git add tests/integration/agent.test.ts && git commit -m "W3: startup cross-validation + access failure-surface integration tests"`

## Checkpoint C（Tasks 6–7 后）

- [ ] `bun run typecheck` 通过
- [ ] `bun test`（全量）通过
- [ ] 手工烟测（可选）：`bun run build && node dist/… run -r <tmp-ws>`（真凭据缺省跳过，CI 面靠 mock 集成测试）

### Task 8: 端到端集成 — AC1–AC4 + /new 编排

**Files:**
- Test: `tests/integration/commands.test.ts`（新建）

**Interfaces:**
- Consumes: Task 7 完整装配（mock server + fake claude 双桩）
- Produces: AC1–AC4 的集成证据 + /new 在跑回合编排证据（plan 评审 R1-F5）

- [ ] **Step 1: Write the failing test**（`tests/integration/commands.test.ts`）

```ts
import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, readdirSync, existsSync, readFileSync } from 'node:fs';
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
  const activeCount = readdirSync(join(ws, '.bot', 'sessions'))
    .filter((f) => f.endsWith('.json'))
    .filter((f) => (JSON.parse(readFileSync(join(ws, '.bot', 'sessions', f), 'utf8')) as { status?: string }).status === 'active').length;
  expect(activeCount).toBe(0);                       // 旧档已闭（close() 改写 status='closed'，文件保留）
  // R2-F3：no-output 永不产出——fresh 回合断言前把 fake 切到 happy（helper 每次 spawn 读当前 env）
  process.env.FAKE_CLAUDE_SCENARIO = 'happy';
  srv.pushTextMessage('rq4', { msgid: 'm4', userId: 'u1', content: '新开始' });         // fresh 回合
  await waitUntil(() => streamsOf(srv).some((s) => s.finish && s.content.includes('假回复')));
  expect(argvLog(stateDir).at(-1)!.resumeId).toBeNull();  // /new 后 fresh（无 resume）
  await gateway.stop(); await srv.stop();
});
```

- [ ] **Step 2: Run it and verify it FAILS or PASSES honestly** — Run: `bun test tests/integration/commands.test.ts` Expected: 若 Task 6/7 已合入则多数直接 PASS（本任务是验收证据固化——任何 FAIL 即实现缺口，回补实现而非改测试）
- [ ] **Step 3: 修正至全绿**（修实现，不改验收断言）
- [ ] **Step 4: Run it and verify it PASSES** — Run: `bun test tests/integration/commands.test.ts` Expected: PASS（7 tests）
- [ ] **Step 5: Commit** — `git add tests/integration/commands.test.ts && git commit -m "W3: end-to-end AC1-AC4 + live /new orchestration integration evidence"`

### Task 9: SPEC.md 契约段 + README 配置行 + 全量门

**Files:**
- Modify: `SPEC.md`（追加「## 命令与访问面（W3 契约）」段）
- Modify: `README.md`（config 表追加 groupMentionName 行；快速开始后追加「访问控制」小节）

**Interfaces:**
- Consumes: Tasks 1–8 全部落定行为
- Produces: 文档契约（后续 W4 与 Human-Review 的对照面）

- [ ] **Step 1: Write the docs**（`SPEC.md` 追加段）：

```md
## 命令与访问面（W3 契约）

- 入站分派序（硬约束）：群帧 chatId 守卫 → access gate → 命令解析 → pending-ask → agent。
  命令永不进 agent 会话；陌生人/拒绝者的任何输入（含命令）只得拒绝文案，不披露命令面。
  一次入站帧恰好一次 access 快照加载——gate/命令//status 共用同一版本（热编辑不撕裂单帧授权）。
- `access.json`（`.bot/`）：`{admin, approved, rejected, groups}` 四键可选字符串数组
  （列表内唯一；缺失/不可读/未知键/非法形状启动即 AccessError（⊂ConfigError）响亮失败）。逐帧热重读；
  运行期损坏沿用 last-known-good + ERROR 日志。tier 优先级 admin > rejected > approved；
  rejected 与 unknown 同文案。
- p2p：非 admin/approved 发送者 → 拒绝文案（notice 一次性流，预算耗尽即丢）、无会话生成。
- 群：仅 `groups` allowlist（chatid）内的 @-提及消息处理（`config.json groupMentionName`
  精确 token 边界匹配后剥离）；groups 非空而缺名启动即拒；非 listed 群、无 @、rejected
  发送者均静默忽略（日志留痕）。群授权 = 群成员资格（v1；rejected 除外）。
- 命令：`/new`（中止在跑回合 + 闭会话档 + 清队列 + 回执）、`/stop`（中止 + 清队列、保留
  会话档；在跑/中止中（stopped/stopping）以中止终帧「已停止当前回合」为唯一回执，idle 时
  幂等提示）、`/status`（仅 admin 单聊：连接态（connected+authenticated）+ 三名单 +
  活跃会话 + 进行中回合）、`/help`。未知命令 → 帮助文案。命令名大小写归一（/STOP = /stop）。
  中止实现：manager.abortChat 哨兵 + SIGINT + 收割梯子，EOF 失败路径发
  turn_failed('turn aborted by user command')。
- enter_chat（每日首个单聊进入）：allowed → replyWelcome（欢迎 + 命令清单）；rejected/unknown
  → 拒绝文案作欢迎。5 s 平台窗内发出（access 同步判定、零前置 await）；群 enter_chat 忽略；
  欢迎不走会话限流器（独立 aibot_respond_welcome_msg 通道）。
- feedback_event：info 日志（msgid/userid/chatType，不记内容），仅此而已。
- 已知未验证面（Human-Review 手工清单）：真实平台 @ 载荷内嵌形状（groupMentionName 吸收）、
  replyWelcome 5s 窗与每日一次语义、群成员资格即授权的产品确认。
```

`README.md` config 表追加一行：

```md
| `groupMentionName` | 非空字符串 | —（groups 非空时必填） | 群 @-提及匹配名：群消息须以 `@<名>` 开头才处理 |
```

快速开始之后追加：

````md
### 访问控制（`.bot/access.json`）

```json
{ "admin": ["你的userid"], "approved": ["同事userid"], "rejected": [], "groups": ["群chatid"] }
```

私聊仅 admin/approved 应答（其余得到拒绝提示）；群聊仅 allowlist 内的 @ 提及应答
（需同时在 `config.json` 配 `groupMentionName`）。改动即时生效（逐消息重读）。
可用命令：`/new` `/stop` `/status`（仅管理员私聊）`/help`。
````

- [ ] **Step 2: Verify docs against behavior** — Run: `bun test` + `bun run typecheck` + 通读 SPEC 新段与 Task 6/8 行为一一对照（每条契约可指回某测试）
- [ ] **Step 3: Full gate** — Run: `bun run typecheck && bun test && bun run build && bun run check:dist` Expected: 全部通过
- [ ] **Step 4: Commit** — `git add SPEC.md README.md && git commit -m "W3: SPEC contract section + README access/config docs"`

## Checkpoint D（Task 9 后——交付门）

- [ ] `bun run typecheck && bun test && bun run build && bun run check:dist` 全绿
- [ ] AC1–AC4 各有对应集成测试且绿（tests/integration/commands.test.ts + agent-handler 单测）
- [ ] 自审：scope 对照 issue 描述——per-repo pairing / transfer_admin / passthrough 未做（out of scope 确认）
- [ ] **Human-Review 证据清单**（plan 评审 R1-F7——PR 描述须携带以下空栏字段，owner 在 Human-Review 阶段逐项填写后方可合并）：
  - 真实群 @ 消息 `text.content` 原文抓样：____（据此时断 `groupMentionName` 取值是否需要调整）
  - 真实 `enter_chat` → 欢迎送达时间戳（≤5s 证据）：____
  - 群成员资格即授权（allow-listed 群任何成员可用）owner 签认：____
  - rejected/unknown 真机拒绝文案送达确认：____

## Risk Notes

- **真实平台 @ 载荷**（高不确定）：`groupMentionName` 配置钮吸收；集成测试以 mock 载荷锁定行为，真实形状留 Human-Review——若真实 content 不含 @ 文案，群策略退化为「全忽略」（fail-safe 方向，不会误收）。
- **/stop 双击与 terminating 竞态**：`'stopping'` 三态消除 idle 误报——首击的中止终帧仍是权威回执（manager 单测锁定三态序列 stopped→stopping→idle）。
- **abort 与 drain 竞态**：abortChat 先 drop 队列再杀——scheduleAfterRelease 找不到队列项，不会复活已停回合（manager 既有代际检查兜底）。
- **welcome 与 access 热读的 IO 成本**：小文件同步读，每入站事件一次——feishubot 生产同构，量级（逐消息）无压力面。
- **W2 测试基线漂移**：access gate 落地后，既有 agent.test.ts 全部用例依赖 setup 补写的 approved access.json（Task 7）——漏改即全体误红，Checkpoint C 全量 `bun test` 是护栏。
