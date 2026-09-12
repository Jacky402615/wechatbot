# wechatbot W1（Gateway skeleton: WeCom 长连接 transport + stream echo）Implementation Plan

**Goal:** 搭起 `@jacky402615/wechatbot` 仓库骨架，并基于 `@wecom/aibot-node-sdk` 的自有 adapter 打通 WeCom 长连接全链路（connect → subscribe → 30 s ping → 断线重连/被踢恢复 → 单聊文本 stream echo `finish=true`）。

**Architecture:** 单一自有 `WeComTransport` port（`src/transport/types.ts`）+ 唯一 SDK 实现 `wecom-sdk-adapter.ts`；薄 `Gateway` 类聚合 transport/logger/stateWriter/handlers，W1 注册 `EchoHandler`（W2 直接替换为 SessionHandler）。CLI 四命令 `run|start|stop|status`，守护化用 detached spawn + pidfile，状态用原子写 `.bot/state.json`。测试用本地 mock WeCom WS 服务端（devDep `ws`）走真实 SDK 验证线上行为，不 mock SDK 类。

**Tech Stack:** bun 1.3.14（CI 同版本钉死）+ TypeScript 5（strict，node builtins，零 Bun 专属 API——`--target=node` 打包，dist 在 node/bun 双运行时可执行）、`@wecom/aibot-node-sdk@1.0.7`（**钉死精确版本**，其根导出 `WSClient`/`WSAuthFailureError`/`WsCmd` 与类型 `WsFrame`/`WsFrameHeaders` 均已从 1.0.7 的 `index.cjs.js` 与 `index.d.ts` 实核）、`ws`（devDep，测试）、`bun test` + `tsc --noEmit`、`bun build --target=node`（SDK external）、GitHub Actions（ci + publish 到 GitHub Packages）。

**Spec:** `docs/issues/1/decisions.md`

## Global Constraints

- AC1: 用 `.env`（`WECOM_BOT_ID`/`WECOM_SECRET`）连接并订阅；订阅失败必须响亮（非零退出码 + ERROR 日志），不得静默。
- AC2: ping 保活：soak 运行 ≥ 10 min 连接存活；被杀 socket 以退避自动重连。
- AC3: 被踢连接（`disconnected_event`）无需重启网关即恢复（继续服务/重新订阅）。
- AC4: 单聊入站文本产生 stream 协议 echo 回复并以 `finish=true` 终止（req_id 透传）。
- AC5: `wechatbot status` 报告连接状态；tests + typecheck 全绿；SPEC.md transport 节与实际行为一致。
- AC6: SDK 只出现在 adapter 后面（换 SDK 只动 adapter）；构建产物 dist 无机器路径（external 打包可验证）。
- feishubot #62 教训：所有 SDK/IO 错误必须记日志并向上传播，禁止吞掉。
- feishubot #76 教训：`@wecom/aibot-node-sdk` 在打包时 external，dist 不得内嵌构建机绝对路径。
- src/ 只用 node 内建模块（`node:*`），不用 Bun 专属 API（含 `import.meta.main`——入口判断用 `import.meta.url === pathToFileURL(process.argv[1]).href`）；测试可用 `bun:test`。
- **每个实现任务的提交门槛统一为 `bun run typecheck && bun test tests/unit tests/integration` 全绿**（Checkpoint 是额外聚合复核，不替代逐任务门槛）。
- SPEC.md 的重连/退避/恢复描述只写集成测试实际验证到的行为（D2 评审条件）。
- 提交纪律：每任务独立提交且全绿（`bun run typecheck && bun test tests/unit tests/integration`）。
- 本计划所有命令的工作目录：`/home/ubuntu/wiki-symphony-ws/projects/wechatbot-ws/workspaces/issues/1`（下称 `$WS`）。

## Tasks

**执行顺序（硬约束，覆盖下方任务编号的字面顺序）**：Task 1 → 2 → 3 → 4 → 5（Checkpoint A）→ 6 → 7 → 8（Checkpoint B）→ 9 → **Task 13 的 Step 1–2（先落地 soak 文件并跑完 10 min 取证）** → 10 → 11 → 12 → Task 13 的 Step 3–4（终检）。理由：SPEC（Task 10）的重连节必须以 soak 实测数据为源，不能引用尚未存在的证据。

### Task 1: 仓库脚手架（package.json / tsconfig / .gitignore / 依赖）

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `src/cli.ts`（占位，Task 9 重写）

**Interfaces:**
- Produces: `bun run typecheck` / `bun test` / `bun run build` 三个 script 入口；npm 包名 `@jacky402615/wechatbot`。

- [x] **Step 1: 写 `package.json`**

```json
{
  "name": "@jacky402615/wechatbot",
  "version": "0.1.0",
  "description": "WeCom 智能机器人 gateway（长连接模式），spawn claude per chat",
  "type": "module",
  "license": "MIT",
  "bin": { "wechatbot": "dist/cli.js" },
  "main": "dist/cli.js",
  "files": ["dist", "SPEC.md", "README.md"],
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "bun test tests/unit tests/integration",
    "test:soak": "bun test tests/soak",
    "build": "bun build src/cli.ts --target=node --outdir=dist --external @wecom/aibot-node-sdk",
    "check:dist": "bash scripts/check-dist.sh",
    "smoke": "bun dist/cli.js --help"
  },
  "dependencies": {
    "@wecom/aibot-node-sdk": "1.0.7"
  },
  "devDependencies": {
    "@types/ws": "^8.5.10",
    "bun-types": "1.3.14",
    "typescript": "^5.5.4",
    "ws": "^8.16.0"
  },
  "publishConfig": { "registry": "https://npm.pkg.github.com" }
}
```

- [x] **Step 2: 写 `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "types": ["bun-types"],
    "strict": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src", "tests", "scripts"]
}
```

- [x] **Step 3: 写 `.gitignore`**

```gitignore
node_modules/
dist/
.bot/
*.log
```

- [x] **Step 4: 写占位 `src/cli.ts`**（首行 shebang 必须保留到最终 dist——Task 11 校验依赖它）

```ts
#!/usr/bin/env node
console.log('wechatbot scaffold');
```

- [x] **Step 5: 建 tests 目录骨架**（后续所有任务的 full gate 依赖这两个目录存在）— `mkdir -p tests/unit tests/integration tests/soak tests/helpers && touch tests/unit/.gitkeep tests/integration/.gitkeep tests/soak/.gitkeep`
- [x] **Step 6: 安装并验证** — Run: `bun install && bun run typecheck && bun test tests/unit tests/integration`
  Expected: install 成功生成 `bun.lock`；typecheck 0 错误；bun test 报 0 tests 且退出 0。
- [x] **Step 7: Commit** — `git add package.json tsconfig.json .gitignore src/cli.ts bun.lock tests && git commit -m "chore: bun+ts scaffold with sdk dependency and gate scripts"`

### Task 2: `.bot/.env` 显式解析（src/env.ts）

**Files:**
- Create: `src/env.ts`
- Test: `tests/unit/env.test.ts`

**Interfaces:**
- Produces: `parseEnvFile(text: string): Record<string, string>`；`loadBotEnv(botDir: string): { botId: string; secret: string }`——**仅在键整行缺失时抛 `EnvError`**（message 含缺失键名与文件路径）；键存在但值为空串**合法返回**（首启模板场景）；`assertCredentials(creds: BotCredentials, envPath: string): void`——空值在此抛 `EnvError`（调用点：`createGateway`，即 transport 启动前）。

- [x] **Step 1: 写失败测试 `tests/unit/env.test.ts`**

```ts
import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnvFile, loadBotEnv, assertCredentials } from '../../src/env';

test('parseEnvFile 解析 KEY=VALUE、注释、空行、引号', () => {
  const text = [
    '# comment',
    'WECOM_BOT_ID=bot1',
    '',
    'WECOM_SECRET="s3 cr?t"',
    "OTHER='x'",
  ].join('\n');
  expect(parseEnvFile(text)).toEqual({
    WECOM_BOT_ID: 'bot1',
    WECOM_SECRET: 's3 cr?t',
    OTHER: 'x',
  });
});

test('loadBotEnv 返回凭据', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-env-'));
  mkdirSync(join(dir, '.bot'), { recursive: true });
  writeFileSync(join(dir, '.bot', '.env'), 'WECOM_BOT_ID=b\nWECOM_SECRET=s\n');
  expect(loadBotEnv(dir)).toEqual({ botId: 'b', secret: 's' });
});

test('loadBotEnv 缺失键抛错并指明键与路径', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-env-'));
  mkdirSync(join(dir, '.bot'), { recursive: true });
  writeFileSync(join(dir, '.bot', '.env'), 'WECOM_BOT_ID=b\n');
  expect(() => loadBotEnv(dir)).toThrow(/WECOM_SECRET.*\.env/);
});

test('loadBotEnv 允许空值（首启模板）；assertCredentials 拒绝空值', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-env-'));
  mkdirSync(join(dir, '.bot'), { recursive: true });
  writeFileSync(join(dir, '.bot', '.env'), 'WECOM_BOT_ID=\nWECOM_SECRET=\n');
  expect(loadBotEnv(dir)).toEqual({ botId: '', secret: '' });
  expect(() => assertCredentials({ botId: '', secret: 'x' }, join(dir, '.bot', '.env'))).toThrow(/WECOM_BOT_ID.*empty/);
  expect(() => assertCredentials({ botId: 'b', secret: 's' }, 'whatever')).not.toThrow();
});
```

- [x] **Step 2: 验证 FAIL** — Run: `bun test tests/unit/env.test.ts`
  Expected: FAIL — `Cannot find module '../../src/env'`。
- [x] **Step 3: 写 `src/env.ts`**

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export class EnvError extends Error {}

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export interface BotCredentials { botId: string; secret: string }

export function loadBotEnv(botDir: string): BotCredentials {
  const envPath = join(botDir, '.env');
  const values = parseEnvFile(readFileSync(envPath, 'utf8'));
  const missing = ['WECOM_BOT_ID', 'WECOM_SECRET'].filter((k) => values[k] === undefined);
  if (missing.length > 0) {
    throw new EnvError(`missing ${missing.join(', ')} in ${envPath}`);
  }
  return { botId: values['WECOM_BOT_ID'] ?? '', secret: values['WECOM_SECRET'] ?? '' };
}

export function assertCredentials(creds: BotCredentials, envPath: string): void {
  const empty = (['botId', 'secret'] as const).filter((k) => creds[k] === '');
  if (empty.length > 0) {
    const keyName = empty.map((k) => (k === 'botId' ? 'WECOM_BOT_ID' : 'WECOM_SECRET')).join(', ');
    throw new EnvError(`${keyName} is empty — fill it in ${envPath}`);
  }
}
```

- [x] **Step 4: 验证 PASS** — Run: `bun run typecheck && bun test tests/unit tests/integration` Expected: 全绿（env 4 项）。
- [x] **Step 5: Commit** — `git add src/env.ts tests/unit/env.test.ts && git commit -m "feat(env): explicit .bot/.env parser with loud missing-credential errors"`

### Task 3: workspace 加载与 `.bot/` 目录树（src/config.ts）

**Files:**
- Create: `src/config.ts`
- Test: `tests/unit/config.test.ts`

**Interfaces:**
- Consumes: Task 2 `EnvError/loadBotEnv`。
- Produces: `interface BotConfig { logLevel: 'debug'|'info'|'warn'|'error'; heartbeatInterval?: number; maxReconnectAttempts?: number }`；`loadWorkspace(workspace: string): { workspace: string; botDir: string; config: BotConfig; creds: BotCredentials }`（首启幂等创建 `.bot/`、`sessions/ uploads/ logs/`、默认 `config.json`、`access.json` 占位 `{}`、`.env` 模板）。

- [x] **Step 1: 写失败测试 `tests/unit/config.test.ts`**

```ts
import { test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWorkspace } from '../../src/config';

function freshWs() { return mkdtempSync(join(tmpdir(), 'wb-cfg-')); }

test('首启创建完整 .bot 树与默认文件', () => {
  const ws = freshWs();
  const { botDir, config, creds } = loadWorkspace(ws);
  expect(botDir).toBe(join(ws, '.bot'));
  for (const sub of ['sessions', 'uploads', 'logs']) {
    expect(existsSync(join(botDir, sub))).toBe(true);
  }
  expect(config).toEqual({ logLevel: 'info' });
  expect(creds).toEqual({ botId: '', secret: '' });
  expect(JSON.parse(readFileSync(join(botDir, 'access.json'), 'utf8'))).toEqual({});
  expect(readFileSync(join(botDir, '.env'), 'utf8')).toContain('WECOM_BOT_ID=');
});

test('二次加载幂等且读回已填凭据', () => {
  const ws = freshWs();
  loadWorkspace(ws);
  writeFileSync(join(ws, '.bot', '.env'), 'WECOM_BOT_ID=b\nWECOM_SECRET=s\n');
  writeFileSync(join(ws, '.bot', 'config.json'), JSON.stringify({ logLevel: 'debug', heartbeatInterval: 5000, maxReconnectAttempts: -1 }));
  const { config, creds } = loadWorkspace(ws);
  expect(config).toEqual({ logLevel: 'debug', heartbeatInterval: 5000, maxReconnectAttempts: -1 });
  expect(creds).toEqual({ botId: 'b', secret: 's' });
});

test('非法 logLevel / 非法数字被拒绝', () => {
  const ws = freshWs();
  loadWorkspace(ws);
  writeFileSync(join(ws, '.bot', 'config.json'), JSON.stringify({ logLevel: 'loud' }));
  expect(() => loadWorkspace(ws)).toThrow(/logLevel/);
  writeFileSync(join(ws, '.bot', 'config.json'), JSON.stringify({ heartbeatInterval: 'x' }));
  expect(() => loadWorkspace(ws)).toThrow(/heartbeatInterval/);
});
```

- [x] **Step 2: 验证 FAIL** — Run: `bun test tests/unit/config.test.ts` Expected: FAIL — 模块不存在。
- [x] **Step 3: 写 `src/config.ts`**

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadBotEnv, type BotCredentials } from './env';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface BotConfig {
  logLevel: LogLevel;
  heartbeatInterval?: number;
  maxReconnectAttempts?: number;
}

export class ConfigError extends Error {}

const DEFAULT_CONFIG: BotConfig = { logLevel: 'info' };

export interface Workspace {
  workspace: string;
  botDir: string;
  config: BotConfig;
  creds: BotCredentials;
}

export function loadWorkspace(workspace: string): Workspace {
  const botDir = join(workspace, '.bot');
  mkdirSync(join(botDir, 'sessions'), { recursive: true });
  mkdirSync(join(botDir, 'uploads'), { recursive: true });
  mkdirSync(join(botDir, 'logs'), { recursive: true });
  const accessPath = join(botDir, 'access.json');
  if (!existsSync(accessPath)) writeFileSync(accessPath, '{}\n');
  const configPath = join(botDir, 'config.json');
  if (!existsSync(configPath)) writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
  const envPath = join(botDir, '.env');
  if (!existsSync(envPath)) {
    writeFileSync(envPath, 'WECOM_BOT_ID=\nWECOM_SECRET=\n');
  }
  const config = parseConfig(readFileSync(configPath, 'utf8'), configPath);
  const creds = loadBotEnv(botDir);
  return { workspace, botDir, config, creds };
}

function parseConfig(text: string, path: string): BotConfig {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch (e) {
    throw new ConfigError(`invalid JSON in ${path}: ${(e as Error).message}`);
  }
  const cfg: BotConfig = { ...DEFAULT_CONFIG };
  if (raw['logLevel'] !== undefined) {
    if (!['debug', 'info', 'warn', 'error'].includes(raw['logLevel'] as string)) {
      throw new ConfigError(`logLevel must be debug|info|warn|error in ${path}`);
    }
    cfg.logLevel = raw['logLevel'] as LogLevel;
  }
  for (const numKey of ['heartbeatInterval', 'maxReconnectAttempts'] as const) {
    const v = raw[numKey];
    if (v !== undefined) {
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new ConfigError(`${numKey} must be a number in ${path}`);
      }
      cfg[numKey] = v;
    }
  }
  return cfg;
}
```

（注：首启模板下 `creds` 为 `{botId:'', secret:''}` **合法返回**——空值校验在 `createGateway`（Task 8）调 `assertCredentials` 完成，即 transport 启动前响亮失败；`status`/`stop` 无需凭据即可运行。）

- [x] **Step 4: 验证 PASS** — Run: `bun run typecheck && bun test tests/unit tests/integration` Expected: 全绿（config 3 项）。
- [x] **Step 5: Commit** — `git add src/config.ts tests/unit/config.test.ts && git commit -m "feat(config): workspace loader creating .bot tree with validated config"`

### Task 4: 结构化 JSONL logger（src/logger.ts）

**Files:**
- Create: `src/logger.ts`
- Test: `tests/unit/logger.test.ts`

**Interfaces:**
- Produces: `class BotLogger`：`constructor(opts: { level: LogLevel; logDir: string; console?: boolean; now?: () => Date })`（`now` 供测试注入时钟）；`debug|info|warn|error(event: string, fields?: Record<string, unknown>): void`；`asSdkLogger(): { debug/info/warn/error(message: string, ...args: unknown[]): void }`；`close(): void`。文件 `.bot/logs/gateway-YYYYMMDD.jsonl`——**路径按每次写入时的日期解析**（长驻进程跨午夜自然滚动），每行 `{ts, level, event, ...fields}`；构造时及日期切换时清理 14 天前旧文件。

- [ ] **Step 1: 写失败测试 `tests/unit/logger.test.ts`**

```ts
import { test, expect } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotLogger } from '../../src/logger';

test('写 JSONL 且级别过滤生效', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-log-'));
  const log = new BotLogger({ level: 'info', logDir: dir, console: false });
  log.debug('noisy', { x: 1 });
  log.info('started', { pid: 42 });
  log.error('boom', { err: 'bad' });
  log.close();
  const files = readdirSync(dir);
  expect(files.length).toBe(1);
  const lines = readFileSync(join(dir, files[0]!), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  expect(lines.length).toBe(2);
  expect(lines[0]!).toEqual(expect.objectContaining({ level: 'info', event: 'started', pid: 42 }));
  expect(lines[0]!.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(lines[1]!.level).toBe('error');
});

test('清理 14 天前的旧日志', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-log-'));
  const oldName = `gateway-${new Date(Date.now() - 16 * 86400_000).toISOString().slice(0, 10).replace(/-/g, '')}.jsonl`;
  writeFileSync(join(dir, oldName), '{}\n');
  const log = new BotLogger({ level: 'info', logDir: dir, console: false });
  log.info('hi');
  log.close();
  expect(readdirSync(dir).includes(oldName)).toBe(false);
});

test('asSdkLogger 适配 SDK Logger 接口', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-log-'));
  const log = new BotLogger({ level: 'debug', logDir: dir, console: false });
  const sdk = log.asSdkLogger();
  sdk.warn('ws close', 'code', 1006);
  log.close();
  const f = readdirSync(dir)[0]!;
  const line = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  expect(line).toEqual(expect.objectContaining({ level: 'warn', event: 'ws close', args: ['code', 1006] }));
});

test('跨日滚动：时钟跨天后新写入落到新日期文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-log-'));
  let fakeNow = new Date('2026-09-13T23:59:30Z');
  const log = new BotLogger({ level: 'info', logDir: dir, console: false, now: () => fakeNow });
  log.info('before-midnight');
  fakeNow = new Date('2026-09-14T00:00:30Z');
  log.info('after-midnight');
  log.close();
  const files = readdirSync(dir).sort();
  expect(files.length).toBe(2);
  expect(files[0]).toBe('gateway-20260913.jsonl');
  expect(files[1]).toBe('gateway-20260914.jsonl');
});
```

- [ ] **Step 2: 验证 FAIL** — Run: `bun test tests/unit/logger.test.ts` Expected: FAIL — 模块不存在。
- [ ] **Step 3: 写 `src/logger.ts`**

```ts
import { appendFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { LogLevel } from './config';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export class BotLogger {
  private lastDay = '';

  constructor(private opts: { level: LogLevel; logDir: string; console?: boolean; now?: () => Date }) {
    this.lastDay = this.today();
    this.prune();
  }

  debug(event: string, fields?: Record<string, unknown>): void { this.write('debug', event, fields); }
  info(event: string, fields?: Record<string, unknown>): void { this.write('info', event, fields); }
  warn(event: string, fields?: Record<string, unknown>): void { this.write('warn', event, fields); }
  error(event: string, fields?: Record<string, unknown>): void { this.write('error', event, fields); }

  asSdkLogger() {
    const wrap = (level: LogLevel) => (message: string, ...args: unknown[]) => {
      this.write(level, message, args.length > 0 ? { args } : undefined);
    };
    return { debug: wrap('debug'), info: wrap('info'), warn: wrap('warn'), error: wrap('error') };
  }

  close(): void {
    // appendFileSync 是同步写，无需 flush；保留 close 以显式结束生命周期（校验文件存在性）
    if (!existsSync(this.currentPath())) this.write('info', 'logger-closed-empty');
  }

  private now(): Date { return this.opts.now ? this.opts.now() : new Date(); }

  private today(): string {
    return this.now().toISOString().slice(0, 10).replace(/-/g, '');
  }

  private currentPath(): string {
    return join(this.opts.logDir, `gateway-${this.today()}.jsonl`);
  }

  private write(level: LogLevel, event: string, fields?: Record<string, unknown>): void {
    if (LEVELS[level] < LEVELS[this.opts.level]) return;
    const day = this.today();
    if (day !== this.lastDay) {   // 跨日：滚动 + 清理
      this.lastDay = day;
      this.prune();
    }
    const entry = { ts: this.now().toISOString(), level, event, ...fields };
    try {
      appendFileSync(join(this.opts.logDir, `gateway-${day}.jsonl`), JSON.stringify(entry) + '\n');
    } catch (e) {
      // feishubot #62: 日志失败必须可见，绝不吞掉
      process.stderr.write(`logger write failed: ${(e as Error).message}\n`);
    }
    if (this.opts.console) {
      const line = `[${level}] ${event}${fields ? ' ' + JSON.stringify(fields) : ''}`;
      (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
    }
  }

  private prune(): void {
    const cutoff = this.now().getTime() - 14 * 86400_000;
    try {
      for (const name of readdirSync(this.opts.logDir)) {
        const m = /^gateway-(\d{8})\.jsonl$/.exec(name);
        if (!m) continue;
        const day = m[1]!;
        const ts = Date.parse(`${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`);
        if (Number.isFinite(ts) && ts < cutoff) rmSync(join(this.opts.logDir, name));
      }
    } catch {
      /* 目录尚不存在：构造方已保证存在 */
    }
  }
}
```

- [ ] **Step 4: 验证 PASS** — Run: `bun run typecheck && bun test tests/unit tests/integration` Expected: 全绿（logger 4 项）。
- [ ] **Step 5: Commit** — `git add src/logger.ts tests/unit/logger.test.ts && git commit -m "feat(logger): JSONL structured logger with prune and sdk adapter"`

### Task 5: 原子状态文件（src/state.ts）

**Files:**
- Create: `src/state.ts`
- Test: `tests/unit/state.test.ts`

**Interfaces:**
- Produces: `interface GatewayState { pid: number; running: boolean; connected: boolean; authenticated: boolean; updatedAt: string; lastError?: string; kickedCount: number; reconnects: number; lastEventAt?: string }`；`class StateError extends Error`；`writeState(botDir: string, state: GatewayState): void`（tmp+rename 原子；**写失败打 stderr 后抛 `StateError`**，由 Gateway 捕获记日志、置内存 lastError——不吞）；`readState(botDir: string): GatewayState | null`（**文件缺失返回 null；文件存在但损坏抛 `StateError`**——status 捕获后显式报 `state corrupt`，与"无状态"区分）；`isPidAlive(pid: number): boolean`（`process.kill(pid, 0)`，EPERM 视为存活但非本用户进程）。

- [ ] **Step 1: 写失败测试 `tests/unit/state.test.ts`**

```ts
import { test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeState, readState, isPidAlive, StateError, type GatewayState } from '../../src/state';

function sample(): GatewayState {
  return {
    pid: process.pid, running: true, connected: true, authenticated: true,
    updatedAt: new Date().toISOString(), kickedCount: 0, reconnects: 0,
  };
}

test('写入后读回一致', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-st-'));
  writeState(dir, sample());
  expect(readState(dir)).toEqual(sample());
});

test('写的是合法 JSON（无残留 tmp 文件）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-st-'));
  writeState(dir, sample());
  JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
  expect(readdirSync(dir).filter((f) => f.includes('tmp'))).toEqual([]);
});

test('isPidAlive：自身 true，不存在的 pid false', () => {
  expect(isPidAlive(process.pid)).toBe(true);
  expect(isPidAlive(2 ** 22)).toBe(false);
});

test('readState：缺失返回 null；损坏抛 StateError；writeState 失败抛 StateError', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-st-'));
  expect(readState(dir)).toBe(null);
  writeFileSync(join(dir, 'state.json'), '{corrupt');
  expect(() => readState(dir)).toThrow(StateError);
  const ro = join(dir, 'no-such-dir');
  expect(() => writeState(ro, sample())).toThrow(StateError);
});
```

（`readdirSync` 需在测试文件顶部 `import { readdirSync } from 'node:fs';` 与第一个 import 合并。）

- [ ] **Step 2: 验证 FAIL** — Run: `bun test tests/unit/state.test.ts` Expected: FAIL — 模块不存在。
- [ ] **Step 3: 写 `src/state.ts`**

```ts
import { existsSync, readFileSync, renameSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface GatewayState {
  pid: number;
  running: boolean;
  connected: boolean;
  authenticated: boolean;
  updatedAt: string;
  lastError?: string;
  kickedCount: number;
  reconnects: number;
  lastEventAt?: string;
}

export class StateError extends Error {}

export function writeState(botDir: string, state: GatewayState): void {
  const final = join(botDir, 'state.json');
  const tmp = join(botDir, `.state.json.tmp-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
    renameSync(tmp, final);
  } catch (e) {
    process.stderr.write(`state write failed: ${(e as Error).message}\n`);
    throw new StateError(`state write failed: ${(e as Error).message}`);
  }
}

export function readState(botDir: string): GatewayState | null {
  const final = join(botDir, 'state.json');
  if (!existsSync(final)) return null;
  try {
    return JSON.parse(readFileSync(final, 'utf8')) as GatewayState;
  } catch (e) {
    throw new StateError(`state file corrupt at ${final}: ${(e as Error).message}`);
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
```

（"写的是合法 JSON"测试内 `readdirSync(dir)` 检查无 `.tmp` 残留——`readdirSync` 已在 import 列表。）

- [ ] **Step 4: 验证 PASS** — Run: `bun run typecheck && bun test tests/unit tests/integration` Expected: 全绿（state 4 项）。
- [ ] **Step 5: Commit** — `git add src/state.ts tests/unit/state.test.ts && git commit -m "feat(state): atomic gateway state file with pid liveness"`

**Checkpoint A（Task 5 后）** — Run: `bun run typecheck && bun test tests/unit`
Expected: typecheck 0 错误；unit 全绿。任一红即停下修复，不带病前进。

### Task 6: mock WeCom WS 服务端（tests/helpers/mock-wecom-server.ts）

**Files:**
- Create: `tests/helpers/mock-wecom-server.ts`
- Test: `tests/integration/mock-server.test.ts`

**Interfaces:**
- Produces: `class MockWecomServer`：`constructor(opts?: { authErrcode?: number })`；`start(): Promise<{ port: number; url: string }>`；`stop(): Promise<void>`；`pushTextMessage(reqId: string, msg: { msgid: string; userId: string; content: string }): void`；`kick(): void`（先推 `aibot_event_callback` `disconnected_event` 再关 socket）；`kill(): void`（直接 terminate 所有 socket）；`sentFrames: Array<{ cmd?: string; headers: { req_id: string }; body?: unknown }>`；`get subscribeCount(): number`；`get pingCount(): number`。应答规则：`aibot_subscribe` → `{headers:{req_id}, errcode: opts.authErrcode ?? 0}`；其余一切带 `req_id` 的帧（含 `ping`、`aibot_respond_msg`）→ `{headers:{req_id}, errcode: 0, errmsg: 'ok'}`。

- [ ] **Step 1: 写失败测试 `tests/integration/mock-server.test.ts`**

```ts
import { test, expect } from 'bun:test';
import WebSocket from 'ws';
import { MockWecomServer } from '../helpers/mock-wecom-server';

test('mock 服务端：subscribe 得 ack，ping 得 ack，respond 帧被记录', async () => {
  const srv = new MockWecomServer();
  const { url } = await srv.start();
  const ws = new WebSocket(url);
  const got: Array<Record<string, unknown>> = [];
  ws.on('message', (d) => got.push(JSON.parse(d.toString())));
  await new Promise<void>((r) => ws.once('open', () => r()));
  const send = (f: unknown) => ws.send(JSON.stringify(f));

  send({ cmd: 'aibot_subscribe', headers: { req_id: 'r1' }, body: { bot_id: 'b', secret: 's' } });
  await waitUntil(() => got.some((f) => f['headers']?.['req_id'] === 'r1'));
  expect(got.find((f) => f['headers']?.['req_id'] === 'r1')).toEqual(expect.objectContaining({ errcode: 0 }));

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
```

- [ ] **Step 2: 验证 FAIL** — Run: `bun test tests/integration/mock-server.test.ts` Expected: FAIL — helper 不存在。
- [ ] **Step 3: 写 `tests/helpers/mock-wecom-server.ts`**

```ts
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
    await new Promise<void>((resolve) => this.wss ? void this.wss.close(() => resolve()) : resolve());
    this.wss = null;
  }
}
```

- [ ] **Step 4: 验证 PASS** — Run: `bun run typecheck && bun test tests/unit tests/integration` Expected: 全绿（mock-server 1 项；本任务是 ws/SDK CJS 互操作的第一个 typecheck 关口，`esModuleInterop` 已在 Task 1 配好）。
- [ ] **Step 5: Commit** — `git add tests/helpers/mock-wecom-server.ts tests/integration/mock-server.test.ts && git commit -m "test: mock wecom ws server speaking the frame protocol"`

### Task 7: Transport port + SDK adapter（本计划最高风险任务）

**Files:**
- Create: `src/transport/types.ts`
- Create: `src/transport/wecom-sdk-adapter.ts`
- Test: `tests/integration/transport.test.ts`

**Interfaces:**
- Produces（`src/transport/types.ts`，后续 Gateway/EchoHandler 全部依赖）:

```ts
export interface ReplyRef { readonly __brand: 'ReplyRef'; readonly reqId: string }

export interface InboundTextMessage {
  msgid: string;
  chatType: 'single' | 'group';
  userId: string;
  content: string;
  replyTo: ReplyRef;
}

export type TransportEvent =
  | { type: 'connected' }
  | { type: 'authenticated' }
  | { type: 'disconnected'; reason: string }
  | { type: 'reconnecting'; attempt: number }
  | { type: 'error'; error: Error }
  | { type: 'kicked' }
  | { type: 'textMessage'; message: InboundTextMessage };

export type TransportHandler = (event: TransportEvent) => void;

export interface WeComTransport {
  start(): Promise<void>;          // 认证成功时 resolve；致命错误 reject
  stop(): Promise<void>;
  replyStream(ref: ReplyRef, streamId: string, content: string, finish: boolean): Promise<void>;
  isConnected(): boolean;
  on(handler: TransportHandler): void;
}

export interface TransportOptions {
  botId: string;
  secret: string;
  wsUrl?: string;                   // 测试与高级部署用；默认官方 wss://
  heartbeatInterval?: number;
  maxReconnectAttempts?: number;
  maxAuthFailureAttempts?: number;
  reconnectInterval?: number;
  requestTimeout?: number;          // SDK 请求超时（ms），测试压缩用
  logger?: { debug(m: string, ...a: unknown[]): void; info(m: string, ...a: unknown[]): void; warn(m: string, ...a: unknown[]): void; error(m: string, ...a: unknown[]): void };
}
```

- [ ] **Step 1: 写失败测试 `tests/integration/transport.test.ts`**

```ts
import { test, expect } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WecomSdkTransport, type TransportEvent, type TransportHandler } from '../../src/transport/wecom-sdk-adapter';
import { MockWecomServer } from '../helpers/mock-wecom-server';

const FAST = { reconnectInterval: 50, heartbeatInterval: 200, requestTimeout: 2000 };

async function waitUntil(cond: () => boolean, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitUntil timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}

function recorder(): { events: TransportEvent[]; push: TransportHandler } {
  const events: TransportEvent[] = [];
  return { events, push: (e) => events.push(e) };
}

test('AC1 路径：认证失败 start() reject 且错误可见', async () => {
  const srv = new MockWecomServer({ authErrcode: 40001 });
  const { url } = await srv.start();
  const t = new WecomSdkTransport({ botId: 'b', secret: 'bad', wsUrl: url, maxAuthFailureAttempts: 2, ...FAST });
  await expect(t.start()).rejects.toThrow(/auth|WS_AUTH|subscribe/i);
  await srv.stop();
});

test('认证成功：start resolve，事件序列含 connected/authenticated', async () => {
  const srv = new MockWecomServer();
  const { url } = await srv.start();
  const t = new WecomSdkTransport({ botId: 'b', secret: 's', wsUrl: url, ...FAST });
  const rec = recorder();
  t.on(rec.push);
  await t.start();
  expect(t.isConnected()).toBe(true);
  expect(rec.events.map((e) => e.type)).toContain('authenticated');
  await t.stop();
  await srv.stop();
});

test('AC2 路径：socket 被杀后自动重连（重新 subscribe）', async () => {
  const srv = new MockWecomServer();
  const { url } = await srv.start();
  const t = new WecomSdkTransport({ botId: 'b', secret: 's', wsUrl: url, maxReconnectAttempts: -1, ...FAST });
  const rec = recorder();
  t.on(rec.push);
  await t.start();
  expect(srv.subscribeCount).toBe(1);
  srv.kill();
  await waitUntil(() => srv.subscribeCount >= 2);
  expect(rec.events.some((e) => e.type === 'reconnecting')).toBe(true);
  await waitUntil(() => t.isConnected());
  await t.stop();
  await srv.stop();
});

test('AC3 路径：disconnected_event（被踢）后无需重启恢复，且恢复后继续服务（再 echo 一条）', async () => {
  const srv = new MockWecomServer();
  const { url } = await srv.start();
  const t = new WecomSdkTransport({ botId: 'b', secret: 's', wsUrl: url, maxReconnectAttempts: -1, ...FAST });
  const rec = recorder();
  t.on(rec.push);
  await t.start();
  srv.kick();
  await waitUntil(() => rec.events.some((e) => e.type === 'kicked'));
  await waitUntil(() => srv.subscribeCount >= 2 && t.isConnected());
  // 恢复后继续服务：新消息仍能收到并正确回执（AC3 的 "recovers" 不只是连上）
  const sentBefore = srv.sentFrames.length;
  srv.pushTextMessage('req-after-kick', { msgid: 'mk', userId: 'u1', content: 'still alive' });
  await waitUntil(() => rec.events.some((e) => e.type === 'textMessage' && e.message.replyTo.reqId === 'req-after-kick'));
  await t.replyStream(rec.events.find((e) => e.type === 'textMessage' && e.message.replyTo.reqId === 'req-after-kick')!.message.replyTo, 'sk', 'still alive', true);
  await waitUntil(() => srv.sentFrames.length === sentBefore + 1);
  const f = srv.sentFrames[srv.sentFrames.length - 1]!;
  expect(f.headers.req_id).toBe('req-after-kick');
  await t.stop();
  await srv.stop();
});

test('textMessage 事件携带解析后的 DTO 与 reqId', async () => {
  const srv = new MockWecomServer();
  const { url } = await srv.start();
  const t = new WecomSdkTransport({ botId: 'b', secret: 's', wsUrl: url, ...FAST });
  const rec = recorder();
  t.on(rec.push);
  await t.start();
  srv.pushTextMessage('req-1', { msgid: 'm1', userId: 'u1', content: 'hello' });
  await waitUntil(() => rec.events.some((e) => e.type === 'textMessage'));
  const msg = rec.events.find((e) => e.type === 'textMessage')!;
  expect(msg).toEqual({
    type: 'textMessage',
    message: { msgid: 'm1', chatType: 'single', userId: 'u1', content: 'hello', replyTo: { __brand: 'ReplyRef', reqId: 'req-1' } },
  });
  await t.stop();
  await srv.stop();
});

test('replyStream 发送 aibot_respond_msg 帧且 finish 透传', async () => {
  const srv = new MockWecomServer();
  const { url } = await srv.start();
  const t = new WecomSdkTransport({ botId: 'b', secret: 's', wsUrl: url, ...FAST });
  await t.start();
  const ref = { __brand: 'ReplyRef', reqId: 'req-9' } as const;
  await t.replyStream(ref, 'stream-1', 'echo back', true);
  await waitUntil(() => srv.sentFrames.length === 1);
  const f = srv.sentFrames[0]!;
  expect(f.cmd).toBe('aibot_respond_msg');
  expect(f.headers.req_id).toBe('req-9');
  expect(f.body).toEqual({ msgtype: 'stream', stream: { id: 'stream-1', content: 'echo back', finish: true } });
  await t.stop();
  await srv.stop();
});

test('错误事件被记录且不吞（feishubot #62）：SDK error 事件转发', async () => {
  const srv = new MockWecomServer();
  const { url } = await srv.start();
  const t = new WecomSdkTransport({ botId: 'b', secret: 's', wsUrl: url, ...FAST });
  const rec = recorder();
  t.on(rec.push);
  await t.start();
  t.emitTestError(new Error('injected'));
  expect(rec.events.some((e) => e.type === 'error' && /injected/.test(e.error.message))).toBe(true);
  await t.stop();
  await srv.stop();
});
```

（`emitTestError` 是 adapter 上仅测试用的后门：`emitTestError(err: Error): void` 直接把错误送进 handler 链——生产代码不调用。）

- [ ] **Step 2: 验证 FAIL** — Run: `bun test tests/integration/transport.test.ts` Expected: FAIL — adapter 模块不存在。
- [ ] **Step 3: 先写 `src/transport/types.ts`（内容即上方 Interfaces 块，逐字落地），再写 `src/transport/wecom-sdk-adapter.ts`**

```ts
import { WSClient, WSAuthFailureError, type WsFrame, type WsFrameHeaders } from '@wecom/aibot-node-sdk';
import type {
  InboundTextMessage, ReplyRef, TransportEvent, TransportHandler, TransportOptions, WeComTransport,
} from './types';

export type { InboundTextMessage, ReplyRef, TransportEvent, TransportHandler, TransportOptions, WeComTransport };

const START_TIMEOUT_MS = 30_000;

export class WecomSdkTransport implements WeComTransport {
  private client: WSClient | null = null;
  private handlers: TransportHandler[] = [];
  private stopped = false;

  constructor(private opts: TransportOptions) {}

  async start(): Promise<void> {
    this.stopped = false;
    const client = new WSClient({
      botId: this.opts.botId,
      secret: this.opts.secret,
      wsUrl: this.opts.wsUrl,
      heartbeatInterval: this.opts.heartbeatInterval,
      maxReconnectAttempts: this.opts.maxReconnectAttempts ?? -1,
      maxAuthFailureAttempts: this.opts.maxAuthFailureAttempts,
      reconnectInterval: this.opts.reconnectInterval,
      requestTimeout: this.opts.requestTimeout,
      logger: this.opts.logger,
    });
    this.client = client;
    let settled = false;

    return new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        settled = true;
        try { client.disconnect(); } catch { /* 已断开 */ }
      };
      const timer = setTimeout(() => {
        if (settled) return;
        cleanup();
        reject(new Error(`transport start timeout after ${START_TIMEOUT_MS}ms (subscribe not confirmed)`));
      }, START_TIMEOUT_MS);
      const fail = (err: Error): void => {
        if (settled) return;
        cleanup();
        reject(err);
      };
      client.on('authenticated', () => {
        if (settled) { this.emit({ type: 'authenticated' }); return; }
        clearTimeout(timer);
        settled = true;
        this.emit({ type: 'authenticated' });
        resolve();
      });
      client.on('connected', () => this.emit({ type: 'connected' }));
      client.on('disconnected', (reason: string) => this.emit({ type: 'disconnected', reason }));
      client.on('reconnecting', (attempt: number) => this.emit({ type: 'reconnecting', attempt }));
      client.on('error', (err: Error) => {
        this.emit({ type: 'error', error: err });
        if (err instanceof WSAuthFailureError || (err as { code?: string }).code === 'WS_AUTH_FAILURE_EXHAUSTED') {
          fail(new Error(`subscribe failed: ${err.message}`, { cause: err }));
        }
      });
      client.on('message.text', (frame: WsFrame) => {
        const body = frame.body as unknown as {
          msgid: string; chattype?: 'single' | 'group'; from: { userid: string }; text: { content: string };
        };
        this.emit({
          type: 'textMessage',
          message: {
            msgid: body.msgid,
            chatType: body.chattype ?? 'single',
            userId: body.from?.userid ?? 'unknown',
            content: body.text?.content ?? '',
            replyTo: refFromFrame(frame),
          },
        });
      });
      client.on('event.disconnected_event', () => this.emit({ type: 'kicked' }));
      client.connect();
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    try {
      this.client?.disconnect();
    } catch (e) {
      this.emit({ type: 'error', error: e as Error });
    }
    this.client = null;
  }

  async replyStream(ref: ReplyRef, streamId: string, content: string, finish: boolean): Promise<void> {
    if (!this.client) throw new Error('transport not started');
    const frame: WsFrameHeaders = { headers: { req_id: ref.reqId } };
    const receipt = await this.client.replyStream(frame, streamId, content, finish);
    if (receipt.errcode !== undefined && receipt.errcode !== 0) {
      throw new Error(`replyStream rejected: errcode=${receipt.errcode} errmsg=${receipt.errmsg}`);
    }
  }

  isConnected(): boolean {
    return this.client?.isConnected ?? false;
  }

  on(handler: TransportHandler): void {
    this.handlers.push(handler);
  }

  emitTestError(err: Error): void {
    this.emit({ type: 'error', error: err });
  }

  private emit(event: TransportEvent): void {
    for (const h of this.handlers) {
      try {
        h(event);
      } catch (e) {
        process.stderr.write(`transport handler crashed: ${(e as Error).message}\n`);
      }
    }
  }
}

function refFromFrame(frame: WsFrame): ReplyRef {
  return { __brand: 'ReplyRef', reqId: frame.headers?.req_id ?? '' };
}
```

**实现注意（必须先跑一次再定稿 SPEC 措辞）**：SDK 的 `WSAuthFailureError` 抛出通道（error 事件 vs 异步 throw）与 `replyStream` 收据帧结构以上述集成测试实测为准。若 AC1 测试发现 SDK 用 `unhandledException` 而非 error 事件传递认证耗尽，则在 `start()` 里额外挂 `process.on('uncaughtException')` 作用域化捕获（仅 start 窗口内），并把实际通道记录进 SPEC.md。**已实核（2026-09-13，1.0.7 tarball）**：`WSClient`/`WSAuthFailureError` 为运行时导出、`WsFrame`/`WsFrameHeaders` 为类型导出、`disconnect(): void` 存在——adapter 的 import 清单安全。

- [ ] **Step 4: 验证 PASS** — Run: `bun run typecheck && bun test tests/unit tests/integration` Expected: 全绿（transport 7 项含被踢后继续服务断言；若 SDK 实际行为与假设不符，修 adapter 至测试表达的行为为准，同步记录差异）。
- [ ] **Step 5: Commit** — `git add src/transport tests/integration/transport.test.ts && git commit -m "feat(transport): wecom sdk adapter behind own transport port"`

### Task 8: EchoHandler + Gateway（AC4 闭环）

**Files:**
- Create: `src/handlers/echo.ts`
- Create: `src/gateway.ts`
- Test: `tests/integration/echo.test.ts`

**Interfaces:**
- Consumes: Task 7 全部产物；Task 4 `BotLogger`；Task 5 `writeState/GatewayState/StateError`；Task 3 `Workspace`；Task 2 `assertCredentials/EnvError`。
- Produces: `class EchoHandler { constructor(transport: WeComTransport, logger: BotLogger); register(): void }`（只处理 `chatType==='single'` 文本，echo 原文，`finish=true` 单帧，streamId 用 `randomUUID()`；群聊 debug 日志忽略）；`class Gateway { constructor(opts: { transport: WeComTransport; logger: BotLogger; botDir: string; pid?: number }); start(): Promise<void>; stop(): Promise<void>; isConnected(): boolean }`（`pid` 缺省 `process.pid`；`isConnected()` 透传 transport——soak 采样用；**EchoHandler 在 `transport.start()` 之前注册**，消除"认证完成与 handler 注册之间消息丢失"竞态；事件→state.json 原子更新：connected/authenticated/disconnected/reconnecting/kicked/error 计数与 lastError；SIGTERM 优雅关闭由调用方注册）；`createGateway(workspace: string, overrides?: Partial<TransportOptions>): Promise<{ gateway: Gateway; workspace: Workspace }>`（组装根：loadWorkspace → BotLogger → `assertCredentials`（空凭据在此抛 `EnvError`，早于 transport 构造）→ WecomSdkTransport，`WECOM_WS_URL` 环境变量可覆盖 wsUrl——测试与高级部署用，信任边界见 decisions.md D12）。

- [ ] **Step 1: 写失败测试 `tests/integration/echo.test.ts`**

```ts
import { test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '../../src/gateway';
import { MockWecomServer } from '../helpers/mock-wecom-server';
import type { ReplyRef } from '../../src/transport/types';

const FAST = { reconnectInterval: 50, heartbeatInterval: 500, requestTimeout: 2000 };

async function waitUntil(cond: () => boolean, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitUntil timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function setup() {
  const ws = mkdtempSync(join(tmpdir(), 'wb-echo-'));
  const { loadWorkspace } = await import('../../src/config');
  loadWorkspace(ws); // 首启建树
  writeFileSync(join(ws, '.bot', '.env'), 'WECOM_BOT_ID=b\nWECOM_SECRET=s\n'); // 有效测试凭据
  const srv = new MockWecomServer();
  const { url } = await srv.start();
  const { gateway } = await createGateway(ws, { wsUrl: url, ...FAST });
  await gateway.start();
  return { ws, srv, gateway };
}

test('AC4：单聊文本 → 单帧 stream echo，finish=true，req_id 透传', async () => {
  const { ws, srv, gateway } = await setup();
  srv.pushTextMessage('req-42', { msgid: 'm42', userId: 'u1', content: '你好 wecom' });
  await waitUntil(() => srv.sentFrames.length === 1);
  const f = srv.sentFrames[0]!;
  expect(f.cmd).toBe('aibot_respond_msg');
  expect(f.headers.req_id).toBe('req-42');
  const body = f.body as { msgtype: string; stream: { content: string; finish: boolean; id: string } };
  expect(body.msgtype).toBe('stream');
  expect(body.stream.content).toBe('你好 wecom');
  expect(body.stream.finish).toBe(true);
  expect(typeof body.stream.id).toBe('string');
  await gateway.stop();
  await srv.stop();
});

test('AC5 前置：state.json 反映 connected 与事件时间', async () => {
  const { ws, srv, gateway } = await setup();
  const st = JSON.parse(readFileSync(join(ws, '.bot', 'state.json'), 'utf8'));
  expect(st.connected).toBe(true);
  expect(st.authenticated).toBe(true);
  expect(st.running).toBe(true);
  srv.pushTextMessage('req-43', { msgid: 'm43', userId: 'u1', content: 'x' });
  await waitUntil(() => srv.sentFrames.length === 1);
  const st2 = JSON.parse(readFileSync(join(ws, '.bot', 'state.json'), 'utf8'));
  expect(st2.lastEventAt).toBeTruthy();
  await gateway.stop();
  const st3 = JSON.parse(readFileSync(join(ws, '.bot', 'state.json'), 'utf8'));
  expect(st3.running).toBe(false);
  await srv.stop();
});

test('被踢计数进入 state，且恢复后 EchoHandler 仍自动应答（AC3 完整闭环）', async () => {
  const { ws, srv, gateway } = await setup();
  const statePath = join(ws, '.bot', 'state.json');
  srv.kick();
  await waitUntil(() => {
    try {
      return (JSON.parse(readFileSync(statePath, 'utf8')) as { kickedCount: number }).kickedCount >= 1;
    } catch { return false; }
  });
  // 重连完成后：handler 仍注册在 transport 上，新消息自动产生 echo（不经手动 replyStream）
  const sentBefore = srv.sentFrames.length;
  await waitUntil(() => srv.subscribeCount >= 2 && gateway.isConnected());  // 旧 socket 关闭 + 新订阅完成
  srv.pushTextMessage('req-post-kick', { msgid: 'mpk', userId: 'u1', content: 'auto echo after kick' });
  await waitUntil(() => srv.sentFrames.length === sentBefore + 1, 10_000);
  const f = srv.sentFrames[srv.sentFrames.length - 1]!;
  expect(f.headers.req_id).toBe('req-post-kick');
  const body = f.body as { stream: { content: string; finish: boolean } };
  expect(body.stream.content).toBe('auto echo after kick');
  expect(body.stream.finish).toBe(true);
  await gateway.stop();
  await srv.stop();
});

test('空凭据：createGateway 在 transport 构造前抛 EnvError', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'wb-echo-'));
  const { loadWorkspace } = await import('../../src/config');
  loadWorkspace(ws); // .env 为空模板
  await expect(createGateway(ws)).rejects.toThrow(/WECOM_BOT_ID.*empty|WECOM_SECRET.*empty/);
});
```

- [ ] **Step 2: 验证 FAIL** — Run: `bun test tests/integration/echo.test.ts` Expected: FAIL — gateway 模块不存在。
- [ ] **Step 3: 写 `src/handlers/echo.ts`**

```ts
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
```

再写 `src/gateway.ts`：

```ts
import { join } from 'node:path';
import { loadWorkspace, type Workspace } from './config';
import { BotLogger } from './logger';
import { writeState, StateError, type GatewayState } from './state';
import { WecomSdkTransport } from './transport/wecom-sdk-adapter';
import type { TransportOptions, WeComTransport } from './transport/types';
import { assertCredentials } from './env';
import { EchoHandler } from './handlers/echo';

export class Gateway {
  private state: GatewayState;
  private stopped = false;

  constructor(private opts: { transport: WeComTransport; logger: BotLogger; botDir: string; pid?: number }) {
    this.state = {
      pid: opts.pid ?? process.pid, running: true, connected: false, authenticated: false,
      updatedAt: new Date().toISOString(), kickedCount: 0, reconnects: 0,
    };
    this.opts.transport.on((event) => this.onEvent(event));
  }

  async start(): Promise<void> {
    // EchoHandler 必须先于 transport.start() 注册：认证完成的瞬间 handler 已就位，
    // 消除"authenticated 与注册之间"的丢消息窗口。
    new EchoHandler(this.opts.transport, this.opts.logger).register();
    try {
      await this.opts.transport.start();
    } catch (e) {
      this.state.lastError = (e as Error).message;
      this.opts.logger.error('gateway start failed', { err: (e as Error).message });
      throw e;
    }
    this.persist({ connected: true, authenticated: true });
    this.opts.logger.info('gateway started', { pid: this.state.pid });
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.opts.transport.stop();
    this.persist({ running: false, connected: false, authenticated: false });
    this.opts.logger.info('gateway stopped', { pid: this.state.pid });
  }

  isConnected(): boolean {
    return this.opts.transport.isConnected();
  }

  private onEvent(event: TransportEventLike): void {
    switch (event.type) {
      case 'connected':
        this.persist({ connected: true });
        break;
      case 'authenticated':
        this.persist({ connected: true, authenticated: true });
        break;
      case 'disconnected':
        this.persist({ connected: false, authenticated: false });
        this.opts.logger.warn('transport disconnected', { reason: event.reason });
        break;
      case 'reconnecting':
        this.persist({ reconnects: this.state.reconnects + 1 });
        this.opts.logger.warn('transport reconnecting', { attempt: event.attempt });
        break;
      case 'kicked':
        this.persist({ kickedCount: this.state.kickedCount + 1, lastError: 'kicked by new connection' });
        this.opts.logger.error('kicked: another connection took over; auto re-subscribing');
        break;
      case 'error':
        this.persist({ lastError: event.error.message });
        this.opts.logger.error('transport error', { err: event.error.message });
        break;
      case 'textMessage':
        this.persist({ lastEventAt: new Date().toISOString() });
        break;
    }
  }

  private persist(patch: Partial<GatewayState>): void {
    this.state = { ...this.state, ...patch, updatedAt: new Date().toISOString() };
    try {
      writeState(this.opts.botDir, this.state);
    } catch (e) {
      // StateError：状态面写失败不拖垮消息面，但必须留痕（不吞）
      if (e instanceof StateError) {
        this.opts.logger.error('state persist failed', { err: e.message });
      } else {
        throw e;
      }
    }
  }
}

type TransportEventLike = Parameters<Parameters<WeComTransport['on']>[0]>[0];

export async function createGateway(
  workspace: string,
  overrides: Partial<TransportOptions> = {},
): Promise<{ gateway: Gateway; workspace: Workspace }> {
  const ws = loadWorkspace(workspace);
  const logger = new BotLogger({ level: ws.config.logLevel, logDir: join(ws.botDir, 'logs'), console: true });
  try {
    assertCredentials(ws.creds, join(ws.botDir, '.env'));   // 空凭据在此响亮失败（AC1 前置）
  } catch (e) {
    logger.error('startup failed: credentials', { err: (e as Error).message });  // 结构化 ERROR 留痕，再抛
    throw e;
  }
  const wsUrl = process.env['WECOM_WS_URL'] ?? overrides.wsUrl;
  const transport = new WecomSdkTransport({
    botId: ws.creds.botId,
    secret: ws.creds.secret,
    heartbeatInterval: ws.config.heartbeatInterval,
    maxReconnectAttempts: ws.config.maxReconnectAttempts,
    logger: logger.asSdkLogger(),
    ...overrides,
    ...(wsUrl ? { wsUrl } : {}),
  });
  const gateway = new Gateway({ transport, logger, botDir: ws.botDir });
  return { gateway, workspace: ws };
}
```

（文件底部的 `type TransportEventLike = Parameters<Parameters<WeComTransport['on']>[0]>[0]` 供 `onEvent` 签名使用。）

- [ ] **Step 4: 验证 PASS** — Run: `bun run typecheck && bun test tests/unit tests/integration` Expected: 全绿（echo 4 项：AC4 单帧、state 可观测、被踢闭环、空凭据——4 个测试在 Step 1 一次写齐，提交门槛不拆批次）。竞态说明：EchoHandler 在 `transport.start()` 前注册（见 Step 3 代码注释），"authenticated 后、注册前"的丢消息窗口被结构性消除——echo 测试在 `gateway.start()` 返回后立即推消息即可覆盖正常路径。
- [ ] **Step 5: Commit** — `git add src/handlers src/gateway.ts tests/integration/echo.test.ts && git commit -m "feat(gateway): echo handler closing AC4 loop with state observability"`

**Checkpoint B（Task 8 后）** — Run: `bun run typecheck && bun test tests/unit tests/integration`
Expected: 全绿。若 transport 测试暴露 SDK 真实行为与假设差异，此时回改 Task 7 并把结论写进 Task 10 的 SPEC 草稿。

### Task 9: CLI 四命令（run / start / stop / status）

**Files:**
- Modify: `src/cli.ts`（重写占位）
- Create: `src/commands/run.ts`、`src/commands/start.ts`、`src/commands/stop.ts`、`src/commands/status.ts`
- Test: `tests/integration/cli.test.ts`、`tests/unit/pid.test.ts`

**Interfaces:**
- Consumes: Task 8 `createGateway`；Task 5 `readState/isPidAlive`；Task 3 `loadWorkspace`。
- Produces: `runCli(argv: string[]): Promise<number>`（返回退出码；`src/cli.ts` 的 main 只做 `process.exit(await runCli(process.argv.slice(2)))`）；解析规则：`wechatbot <run|start|stop|status> [-r <workspace>] [-h|--help]`，workspace 默认 `process.cwd()`；未知命令/重复 `-r`/缺参数 → stderr + 退出 2。pidfile：`.bot/gateway.pid`。

- [ ] **Step 1: 写失败测试 `tests/integration/cli.test.ts`**

```ts
import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import { runCli } from '../../src/cli';
import { MockWecomServer } from '../helpers/mock-wecom-server';

const FAST = { reconnectInterval: 50, heartbeatInterval: 500, requestTimeout: 2000 };

test('无参数退出 2 并打印用法', async () => {
  expect(await runCli([])).toBe(2);
});
test('未知命令退出 2', async () => {
  expect(await runCli(['frobnicate'])).toBe(2);
});
test('重复 -r 退出 2', async () => {
  expect(await runCli(['run', '-r', '/a', '-r', '/b'])).toBe(2);
});
test('--help 退出 0 且含四个命令', async () => {
  const orig = process.stdout.write.bind(process.stdout);
  let out = '';
  process.stdout.write = ((s: string) => { out += s; return true; }) as typeof process.stdout.write;
  const rc = await runCli(['--help']);
  process.stdout.write = orig;
  expect(rc).toBe(0);
  expect(out).toMatch(/run.*start.*stop.*status/s);
});

test('AC1 端到端：坏凭据 run 子进程非零退出', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'wb-cli-'));
  const { loadWorkspace } = await import('../../src/config');
  loadWorkspace(ws); // 首启建树（生成 .bot/ 与模板文件）
  writeFileSync(join(ws, '.bot', '.env'), 'WECOM_BOT_ID=b\nWECOM_SECRET=bad\n');
  const srv = new MockWecomServer({ authErrcode: 40001 });
  const { url } = await srv.start();
  const r = spawnSync('bun', ['src/cli.ts', 'run', '-r', ws], {
    env: { ...process.env, WECOM_WS_URL: url },
    timeout: 30_000,
  });
  expect(r.status).not.toBe(0);
  expect(r.stderr.toString()).toMatch(/subscribe|auth|credential|启动失败/i);
  // 结构化 ERROR 留痕（feishubot #62）：JSONL 里必须能查到这次启动失败
  const logsDir = join(ws, '.bot', 'logs');
  const logText = readdirSync(logsDir).map((f) => readFileSync(join(logsDir, f!), 'utf8')).join('');
  expect(logText).toMatch(/"level":"error"/);
  await srv.stop();
}, 60_000);

test('AC1 空凭据：非零退出 + JSONL ERROR 记录', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'wb-cli-'));
  const { loadWorkspace } = await import('../../src/config');
  loadWorkspace(ws); // .env 为空模板
  const r = spawnSync('bun', ['src/cli.ts', 'run', '-r', ws], { timeout: 20_000 });
  expect(r.status).toBe(1);
  expect(r.stderr.toString()).toMatch(/WECOM_BOT_ID.*empty|WECOM_SECRET.*empty/);
  const logsDir = join(ws, '.bot', 'logs');
  const logText = readdirSync(logsDir).map((f) => readFileSync(join(logsDir, f!), 'utf8')).join('');
  expect(logText).toMatch(/"event":"startup failed: credentials"/);
});
```

（start/stop/status 测试：）

```ts
test('AC5：start 后 status 报告 connected，stop 后 not running', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'wb-cli-'));
  const srv = new MockWecomServer();
  const { url } = await srv.start();
  const { loadWorkspace } = await import('../../src/config');
  loadWorkspace(ws); // 首启建树
  writeFileSync(join(ws, '.bot', '.env'), 'WECOM_BOT_ID=b\nWECOM_SECRET=good\n');
  writeFileSync(join(ws, '.bot', 'config.json'), JSON.stringify({ logLevel: 'info', heartbeatInterval: 500 }));
  const child = spawn('bun', ['src/cli.ts', 'start', '-r', ws], {
    env: { ...process.env, WECOM_WS_URL: url },
    stdio: 'ignore',
  });
  const startRc = await new Promise<number>((r) => child.once('exit', (c) => r(c ?? -1)));
  expect(startRc).toBe(0);
  await waitUntil(async () => (await runCliOut(['status', '-r', ws])).includes('"connected": true'), 15_000);
  expect(await runCli(['stop', '-r', ws])).toBe(0);
  expect((await runCliOut(['status', '-r', ws]))).toMatch(/"running": false|not running/);
  await srv.stop();
}, 60_000);

test('status：pid 死亡时归一陈旧状态（无僵尸 connected）', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'wb-cli-'));
  const { loadWorkspace } = await import('../../src/config');
  loadWorkspace(ws);
  const { writeState } = await import('../../src/state');
  writeState(join(ws, '.bot'), {
    pid: 2 ** 22, running: true, connected: true, authenticated: true,
    updatedAt: new Date().toISOString(), kickedCount: 0, reconnects: 0,
  }); // 模拟：state 说在跑，pid 早已不存在
  const out = await runCliOut(['status', '-r', ws]);
  expect(out).toMatch(/"stale": true/);
  expect(out).toMatch(/"running": false/);
});

async function runCliOut(argv: string[]): Promise<string> {
  const r = spawnSync('bun', ['src/cli.ts', ...argv], { timeout: 15_000 });
  return r.stdout.toString() + r.stderr.toString();
}

async function waitUntil(cond: () => Promise<boolean> | boolean, ms = 15000): Promise<void> {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error('waitUntil timeout');
    await new Promise((r) => setTimeout(r, 100));
  }
}
```

- [ ] **Step 2: 验证 FAIL** — Run: `bun test tests/integration/cli.test.ts` Expected: FAIL — `src/cli` 无 `runCli` 导出。
- [ ] **Step 3: 重写 `src/cli.ts` 并创建四个命令模块**

`src/cli.ts`：

```ts
import { run as runCmd } from './commands/run';
import { start as startCmd } from './commands/start';
import { stop as stopCmd } from './commands/stop';
import { status as statusCmd } from './commands/status';

const USAGE = `wechatbot — WeCom 智能机器人 gateway（长连接模式）

用法: wechatbot <command> [-r <workspace>]
命令: run | start | stop | status
  run     前台运行网关
  start   后台守护启动
  stop    停止后台网关
  status  报告连接状态
选项: -r <workspace>  工作区目录（默认 $PWD，状态与日志在 <workspace>/.bot/）
      -h, --help     显示本帮助`;

export async function runCli(argv: string[]): Promise<number> {
  let command = '';
  let workspace = process.cwd();
  let workspaceSeen = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '-h' || a === '--help') { process.stdout.write(USAGE + '\n'); return 0; }
    if (a === '-r') {
      const v = argv[i + 1];
      if (!v || v.startsWith('-')) { process.stderr.write('错误: -r 需要一个目录参数\n'); return 2; }
      if (workspaceSeen) { process.stderr.write('错误: -r 只能出现一次\n'); return 2; }
      workspace = v; workspaceSeen = true; i += 1;
    } else if (!command) {
      command = a;
    } else {
      process.stderr.write(`错误: 未知参数 ${a}\n${USAGE}\n`); return 2;
    }
  }
  if (!['run', 'start', 'stop', 'status'].includes(command)) {
    process.stderr.write(command ? `错误: 未知命令 ${command}\n${USAGE}\n` : USAGE + '\n');
    return 2;
  }
  switch (command) {
    case 'run': return runCmd({ workspace });
    case 'start': return startCmd({ workspace });
    case 'stop': return stopCmd({ workspace });
    case 'status': return statusCmd({ workspace });
  }
}

// 可移植入口判断（node/bun 双运行时；import.meta.main 是 Bun 专属）
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await runCli(process.argv.slice(2)));
}
```

`tests/unit/pid.test.ts`（解析正确性——真实 /proc 字段布局的代表性样本）：

```ts
import { test, expect } from 'bun:test';
import { parseStartTime, processStartTime, isPidAlive } from '../../src/pid';

test('parseStartTime：comm 含空格/括号也能取到字段 22', () => {
  // 真实布局：pid (comm) state ppid ... starttime(字段22) ...
  // 剥去 "1234 (bun (worker)) " 后字段 3 起算 → 字段 22 = 索引 19；
  // 下方样本：S..12 共 19 个 token（字段 3..21），随后 777777 = 字段 22（starttime），88888888 = vsize
  const line = '1234 (bun (worker)) S 1 1234 1234 0 -1 4194560 100 0 0 0 5 6 7 8 9 10 11 12 777777 88888888 99';
  expect(parseStartTime(line)).toBe(777777);
  expect(parseStartTime('no parens here')).toBe(null);
});

test('processStartTime/isPidAlive 对自身进程自洽', () => {
  expect(processStartTime(process.pid)).toBeGreaterThan(0);
  expect(isPidAlive(process.pid)).toBe(true);
});
```

`src/commands/run.ts`：

```ts
import { createGateway, type Gateway } from '../gateway';
import { EnvError } from '../env';
import { ConfigError } from '../config';

export async function run(opts: { workspace: string }): Promise<number> {
  let gateway: Gateway;
  try {
    ({ gateway } = await createGateway(opts.workspace));
  } catch (e) {
    if (e instanceof EnvError || e instanceof ConfigError) {
      process.stderr.write(`[wechatbot] 启动失败（凭据/配置）: ${e.message}\n`);
      return 1; // AC1：响亮失败，非零退出
    }
    process.stderr.write(`[wechatbot] 启动失败: ${(e as Error).message}\n`);
    return 1;
  }
  // 信号句柄先于 start 注册：start 期间收到 SIGTERM 也能优雅退出
  let stopping = false;
  const shutdown = (sig: string) => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`[wechatbot] 收到 ${sig}，正在优雅关闭…\n`);
    void gateway.stop().finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  try {
    await gateway.start();
  } catch (e) {
    process.stderr.write(`[wechatbot] 网关启动失败: ${(e as Error).message}\n`);
    return 1;
  }
  await new Promise<never>(() => undefined); // 前台常驻，直到信号
}
```

`src/commands/start.ts`：

```ts
import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { loadWorkspace } from '../config';
import { readPidFile, writePidFile, isOurProcess, isPidAlive } from '../pid';

export async function start(opts: { workspace: string }): Promise<number> {
  const ws = loadWorkspace(opts.workspace); // 同时完成首启建树；凭据为空在这里不致命（子进程会响亮失败）
  const pidPath = join(ws.botDir, 'gateway.pid');
  const existing = readPidFile(pidPath);
  if (existing !== null && isOurProcess(existing)) {
    process.stderr.write(`已有网关在运行 (pid ${existing.pid})；如需重启先 wechatbot stop\n`);
    return 1;
  }
  mkdirSync(join(ws.botDir, 'logs'), { recursive: true });
  const outFd = openSync(join(ws.botDir, 'logs', 'daemon-stdout.log'), 'a');
  const errFd = openSync(join(ws.botDir, 'logs', 'daemon-stderr.log'), 'a');
  const child = spawn(process.execPath, [process.argv[1]!, 'run', '-r', opts.workspace], {
    detached: true, stdio: ['ignore', outFd, errFd], env: process.env,
  });
  child.unref();
  writePidFile(pidPath, child.pid!);
  // 等待一小段确认子进程没有立刻死掉（凭据缺失等——AC1 经由子进程非零退出兜底）
  await new Promise((r) => setTimeout(r, 1500));
  if (!isPidAlive(child.pid!)) {
    process.stderr.write(`网关子进程启动即退出；详见 ${ws.botDir}/logs/daemon-stderr.log\n`);
    return 1;
  }
  process.stdout.write(`网关已后台启动 (pid ${child.pid})；状态: wechatbot status -r ${opts.workspace}\n`);
  return 0;
}
```

`src/commands/stop.ts`：

```ts
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadWorkspace } from '../config';
import { readPidFile, isOurProcess, isPidAlive } from '../pid';
import { readState, writeState } from '../state';

export async function stop(opts: { workspace: string }): Promise<number> {
  const ws = loadWorkspace(opts.workspace);
  const pidPath = join(ws.botDir, 'gateway.pid');
  const entry = readPidFile(pidPath);
  const pid = entry?.pid ?? null;
  if (entry === null || !isOurProcess(entry)) {
    process.stdout.write('网关未在运行\n');
    rmSync(pidPath, { force: true });
    return 0;
  }
  process.kill(pid!, 'SIGTERM');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && isPidAlive(pid!)) await new Promise((r) => setTimeout(r, 200));
  if (isPidAlive(pid!)) {
    process.kill(pid!, 'SIGKILL');
    process.stdout.write(`pid ${pid} 未在 5s 内退出，已 SIGKILL\n`);
  }
  rmSync(pidPath, { force: true });
  try {
    const st = readState(ws.botDir);
    if (st) writeState(ws.botDir, { ...st, running: false, connected: false, updatedAt: new Date().toISOString() });
  } catch (e) {
    // 进程停止是主职责，state 更新失败不阻断——但必须留痕，不吞（feishubot #62）
    process.stderr.write(`[wechatbot] stop: state 更新失败（进程已停止）: ${(e as Error).message}\n`);
  }
  process.stdout.write(`网关已停止 (pid ${pid})\n`);
  return 0;
}
```

`src/commands/status.ts`（pid 已死时归一陈旧状态，绝不输出"僵尸 connected"）：

```ts
import { join } from 'node:path';
import { loadWorkspace } from '../config';
import { readPidFile, isOurProcess } from '../pid';
import { readState, StateError } from '../state';

export async function status(opts: { workspace: string }): Promise<number> {
  const ws = loadWorkspace(opts.workspace);
  const entry = readPidFile(join(ws.botDir, 'gateway.pid'));
  let st = null;
  try {
    st = readState(ws.botDir);
  } catch (e) {
    if (e instanceof StateError) {
      process.stdout.write(`wechatbot: state corrupt (${e.message})\n`);
      return 1;
    }
    throw e;
  }
  const alive = entry !== null && isOurProcess(entry);
  if (!alive && (st === null || !st.running)) {
    process.stdout.write('wechatbot: not running\n');
    return 0;
  }
  const normalized = alive ? st : { ...st, running: false, connected: false, stale: true };
  process.stdout.write(JSON.stringify({ pid: entry?.pid ?? st?.pid ?? null, ...normalized, pidAlive: alive }, null, 2) + '\n');
  return 0;
}
```

新增 `src/pid.ts`（pidfile 读写 + 归属校验，Task 9 内一并提交）：

```ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isPidAlive } from './state';

export interface PidFile { pid: number; startedAt: number | null }

/** 解析 /proc/<pid>/stat 的第 22 字段 starttime（剥去 "pid (comm) " 后，字段 3 起算 → 字段 22 = 索引 19） */
export function parseStartTime(statLine: string): number | null {
  const close = statLine.lastIndexOf(')');
  if (close < 0) return null;
  const fields = statLine.slice(close + 2).split(' ');
  const v = Number.parseInt(fields[19] ?? '', 10);
  return Number.isFinite(v) ? v : null;
}

/** /proc/<pid>/stat 第 22 字段（启动时钟滴答）；非 Linux 或读取失败返回 null（跳过归属校验） */
export function processStartTime(pid: number): number | null {
  try {
    return parseStartTime(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return null;
  }
}

export function writePidFile(path: string, pid: number): void {
  const entry: PidFile = { pid, startedAt: processStartTime(pid) };
  writeFileSync(path, JSON.stringify(entry));
}

export function readPidFile(path: string): PidFile | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<PidFile>;
    if (typeof raw.pid !== 'number' || raw.pid <= 0) return null;
    return { pid: raw.pid, startedAt: typeof raw.startedAt === 'number' ? raw.startedAt : null };
  } catch {
    return null;
  }
}

/** pid 存活且（可校验时）启动时间匹配——防 pid 复用误杀/误报 */
export function isOurProcess(entry: PidFile): boolean {
  if (!isPidAlive(entry.pid)) return false;
  if (entry.startedAt === null) return true; // 平台不支持校验，降级为仅存活
  return processStartTime(entry.pid) === entry.startedAt;
}

export { isPidAlive };
```

- [ ] **Step 4: 验证 PASS** — Run: `bun run typecheck && bun test tests/unit tests/integration` Expected: 全绿（cli 8 项：用法/未知命令/重复 -r/帮助/AC1 坏凭据/AC1 空凭据/AC5 起停/陈旧状态）。
- [ ] **Step 5: Commit** — `git add src/cli.ts src/commands src/pid.ts tests/integration/cli.test.ts && git commit -m "feat(cli): run/start/stop/status commands with pidfile daemon lifecycle"`

### Task 10: SPEC.md（transport 行为契约）+ README

**Files:**
- Create: `SPEC.md`
- Modify: `README.md`（首提交 `805bf6b` 已含 12 字节占位 README——本任务重写）

**Interfaces:**
- Consumes: Task 7/8/9 实测行为（重连/被踢/echo 的测试结论）+ Task 13 的 soak 实测时延。
- Produces: 仓库根行为契约，含 transport 节。

- [ ] **Step 0: 先取证据（硬前置）** — 按「执行顺序」此时 Task 13 Step 1–2 已完成（soak 文件已落地且已跑过）。若尚未跑：先做 Task 13 Step 1–2 再回到本步。
  记录 soak console 输出的 `outageMs` / `resubscribeDelayMs`；同时从 Task 7/8 测试日志摘取重连观察。**SPEC 重连节的每个时序数字只能来自这些实测值——禁止占位符进入提交。**
- [ ] **Step 1: 写 `SPEC.md`**（结构如下，措辞以 Step 0 实测数据为准）：

```md
# wechatbot SPEC

WeCom 智能机器人 gateway，长连接模式。镜像 feishubot 的角色：每会话 spawn claude 并流式回传（agent 层为 W2+，本版仅 echo）。

## Transport（W1 契约）

- 连接：`wss://openws.work.weixin.qq.com`。高级/测试：环境变量 `WECOM_WS_URL` 可覆盖连接地址
  （信任假设：进程环境属运维控制面——详见 docs/issues/1/decisions.md D12；README 快速开始不涉及）。
- 认证：`aibot_subscribe`，凭据来自 `<workspace>/.bot/.env` 的 `WECOM_BOT_ID`/`WECOM_SECRET`。
  凭据缺失或订阅失败：ERROR 日志 + 进程非零退出（不静默、不空转）。
- 心跳：SDK 内建 ping，默认 30 s（config.json `heartbeatInterval` 可调）。
- 重连：SDK 内建，默认无限重试（`maxReconnectAttempts: -1`，config.json 可调）。
  退避与恢复细节**以实测为准**：【执行时填写：Task 7 集成测试与 Task 13 soak 在 mock 服务端观察到的
  重连时延序列 / 被踢后重订阅行为——未观察到的时序参数不得写入本节】。
- 被踢（`disconnected_event`）：有新连接顶替旧连接。网关不退出：记录 ERROR 与 kickedCount，
  自动重新 subscribe 恢复服务。
- 单连接约束：一个 bot 同时只有一条活动连接。

## Echo（W1 契约）

- 入站 `aibot_msg_callback` 文本（仅 `chattype === "single"`）：以 `aibot_respond_msg` stream 协议
  回显原文——单帧，`finish=true`，`stream.id` 为 UUID，`req_id` 透传自回调帧。
- W1 只订阅文本回调（SDK `message.text`）；群聊文本：忽略（debug 日志）。

## CLI（W1 契约）

- `wechatbot run|start|stop|status [-r <workspace>]`；`-r` 默认 `$PWD`。
- `.bot/` 布局：`.env`（凭据）、`config.json`（logLevel / heartbeatInterval / maxReconnectAttempts）、
  `access.json`（W3 前为空占位）、`sessions/ uploads/ logs/`、`state.json`（status 数据源）、
  `gateway.pid`（守护 pidfile）。
- 日志：`.bot/logs/gateway-YYYYMMDD.jsonl`，JSONL，按日切分，保留 14 天。
- 退出码：0 正常；1 运行期失败（凭据/订阅/启动即死）；2 用法错误。
```

- [ ] **Step 2: 更新 `README.md`**：项目一句话、安装（GitHub Packages：`@jacky402615/wechatbot`，`.npmrc` 指 `https://npm.pkg.github.com`）、快速开始（填 `.env` → `wechatbot start` → `wechatbot status`）、指向 SPEC.md。**快速开始不提 `WECOM_WS_URL`**（D12）。
- [ ] **Step 3: 验证** — Run: `bun run typecheck && bun test tests/unit tests/integration && grep -c 'stream' SPEC.md && ! grep -nE '〔|TBD|待填|执行时填写' SPEC.md`
  Expected: 全绿；grep ≥ 1；SPEC 无占位残渣（Step 0 已把实测值填入重连节）。
- [ ] **Step 4: Commit** — `git add SPEC.md README.md && git commit -m "docs: SPEC transport behavior contract and README quickstart"`

### Task 11: 构建管道 + dist 洁净校验（AC6）

**Files:**
- Create: `scripts/check-dist.sh`

**Interfaces:**
- Consumes: Task 1 `build` script。
- Produces: `bash scripts/check-dist.sh` 退出 0 = dist 无机器路径且可执行。

- [ ] **Step 1: 写 `scripts/check-dist.sh`**

```bash
#!/usr/bin/env bash
# AC6: dist 不得包含构建机绝对路径（feishubot #76 教训），SDK 保持 external，CLI 入口双运行时可执行。
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f dist/cli.js ] || { echo "FAIL: dist/cli.js 不存在（先 bun run build）"; exit 1; }
if grep -rnE '/home/|/Users/|/root/|/tmp/|[A-Za-z]:\\\\' dist/; then
  echo "FAIL: dist 内嵌机器路径"; exit 1
fi
head -1 dist/cli.js | grep -q '^#!' || { echo "FAIL: dist/cli.js 缺 shebang"; exit 1; }
# SDK external：import 语句存在 + SDK 源码未内联（协议串只在 SDK 内部出现）
grep -qE 'from[[:space:]]*"@wecom/aibot-node-sdk"|require\([[:space:]]*"@wecom/aibot-node-sdk"\)' dist/cli.js \
  || { echo "FAIL: dist 未以 import/require 引用 SDK"; exit 1; }
if grep -rq 'aibot_subscribe' dist/; then
  echo "FAIL: dist 内联了 SDK 源码（aibot_subscribe 出现）——SDK 必须外部化"; exit 1
fi
bun dist/cli.js --help | grep -q 'status'    # 冒烟断言帮助文本真实输出（防空转退出 0 的假绿）
node dist/cli.js --help | grep -q 'status'   # node 强制冒烟（--target=node 契约，同样断言文本）
echo "OK: dist clean and runnable"
```

- [ ] **Step 2: 构建 + 校验** — Run: `chmod +x scripts/check-dist.sh && bun install && bun run build && bun run check:dist`
  Expected: `OK: dist clean and runnable`；若 grep 命中（如 sourcemap 内路径），在 build script 追加 `--sourcemap=none` 后重验。
- [ ] **Step 3: 确认 SDK external** — 已并入 Step 1 脚本（import 存在 + `aibot_subscribe` 不出现双断言）。
- [ ] **Step 4: Commit** — `git add scripts/check-dist.sh && git commit -m "build: dist cleanliness gate (no machine paths, shebang, smoke)"`

### Task 12: CI + GitHub Packages 发布管道

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/publish.yml`

**Interfaces:**
- Consumes: Task 1 scripts、Task 11 check:dist。
- Produces: PR/push 上跑 test+typecheck+build+dist 校验；tag `v*` 发布到 GitHub Packages。

- [ ] **Step 1: 写 `.github/workflows/ci.yml`**

```yaml
name: ci
on:
  push: { branches: [main] }
  pull_request:
jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: "1.3.14" }   # 与本地/沙箱及 bun-types 钉死同版
      - run: bun install --frozen-lockfile
      - run: bun run typecheck
      - run: bun test tests/unit tests/integration
      - run: bun run build
      - run: bun run check:dist
```

- [ ] **Step 2: 写 `.github/workflows/publish.yml`**

```yaml
name: publish
on:
  push: { tags: ['v*'] }
jobs:
  publish:
    runs-on: ubuntu-latest
    permissions: { contents: read, packages: write }
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: "1.3.14" }
      - run: bun install --frozen-lockfile
      - run: bun run typecheck && bun test tests/unit tests/integration
      - run: bun run build && bun run check:dist
      - uses: actions/setup-node@v4
        with: { node-version: 22, registry-url: https://npm.pkg.github.com }
      - run: npm publish
        env: { NODE_AUTH_TOKEN: "${{ secrets.GITHUB_TOKEN }}" }
```

- [ ] **Step 3: 验证** — Run: `bun run typecheck && grep -c 'jobs:' .github/workflows/ci.yml .github/workflows/publish.yml && grep -c '1.3.14' .github/workflows/ci.yml .github/workflows/publish.yml`
  Expected: typecheck 0 错误；两文件各命中 `jobs:` ≥1 与版本钉死 ≥1（YAML 语法的完整校验由首个 CI 运行兜底——列入 Human-Review 观察项；不依赖宿主机 PyYAML）。
- [ ] **Step 4: Commit** — `git add .github/workflows && git commit -m "ci: test/typecheck/dist gates and github packages publish pipeline"`

### Task 13: Soak 测试（AC2 的 10 分钟证据）+ 收尾复核

**Files:**
- Create: `tests/soak/soak.test.ts`

**Interfaces:**
- Consumes: Task 8 `createGateway`、Task 6 mock 服务端。
- Produces: `bun run test:soak`（真实 30 s 心跳，10 min，中途第 5 min kill 一次验证重连）。

- [ ] **Step 1: 写 `tests/soak/soak.test.ts`**

```ts
import { test, expect } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '../../src/gateway';
import { MockWecomServer } from '../helpers/mock-wecom-server';

const SOAK_MS = 10 * 60 * 1000;    // AC2: ≥10 min
const KILL_AT = 5 * 60 * 1000;
const OUTAGE_GRACE_MS = 30_000;    // kill 后允许的最长失联窗口（重连退避 + 余量）

test('soak: 10 min 持续存活 + 中途断链有界恢复（AC2）', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'wb-soak-'));
  const srv = new MockWecomServer();
  const { url } = await srv.start();
  const { gateway } = await createGateway(ws, {
    wsUrl: url,
    heartbeatInterval: 30_000,     // 真实心跳间隔
    reconnectInterval: 200,
    maxReconnectAttempts: -1,
  });
  await gateway.start();

  const t0 = Date.now();
  let killed = false;
  let killAt = 0;
  let recoveredAt = 0;
  let outageViolations = 0;
  let livenessSamples = 0;
  let aliveSamples = 0;

  const sampler = setInterval(() => {
    livenessSamples += 1;
    const alive = gateway.isConnected();
    if (alive) {
      aliveSamples += 1;
      if (killed && !recoveredAt) recoveredAt = Date.now();
    }
    // 恢复后必须持续在线；kill 后超过宽限期仍未恢复即违规
    if (killed && !alive && Date.now() - killAt > OUTAGE_GRACE_MS) outageViolations += 1;
  }, 1_000);
  const killer = setInterval(() => {
    if (!killed && Date.now() - t0 >= KILL_AT) { killed = true; killAt = Date.now(); srv.kill(); }
  }, 1000);

  try {
    while (Date.now() - t0 < SOAK_MS) await new Promise((r) => setTimeout(r, 5_000));
  } finally {
    clearInterval(sampler);
    clearInterval(killer);
  }

  // 心跳：10 min / 30 s ≈ 20 次，容差 -2（边界抖动）
  expect(srv.pingCount).toBeGreaterThanOrEqual(Math.floor(SOAK_MS / 30_000) - 2);
  expect(killed).toBe(true);
  expect(srv.subscribeCount).toBeGreaterThanOrEqual(2);          // kill 后重新 subscribe
  expect(recoveredAt).toBeGreaterThan(0);                        // 恢复时间点被观测到
  expect(recoveredAt - killAt).toBeLessThanOrEqual(OUTAGE_GRACE_MS); // 恢复在有界窗口内
  // 退避证据：重订阅发生在 kill 之后至少一个 reconnectInterval（非立即重试）
  const resubscribeDelay = (srv.subscribeTimes[srv.subscribeTimes.length - 1] ?? 0) - killAt;
  expect(resubscribeDelay).toBeGreaterThanOrEqual(200);          // = soak 配置的 reconnectInterval
  expect(outageViolations).toBe(0);                               // 恢复后无再次失联
  const deadSamples = livenessSamples - aliveSamples;
  const killWindowSamples = Math.ceil((recoveredAt - killAt) / 1_000) + 2; // 容差
  expect(deadSamples).toBeLessThanOrEqual(killWindowSamples);    // 失联样本只出现在 kill 窗口内
  console.log(JSON.stringify({ soakMs: Date.now() - t0, pings: srv.pingCount, subscribes: srv.subscribeCount, outageMs: recoveredAt - killAt, resubscribeDelayMs: resubscribeDelay }));
  await gateway.stop();
  await srv.stop();
}, SOAK_MS + 120_000);
```

（顺序说明：soak 是 AC2 的**时长证据**而非逻辑首验——重连/保活逻辑已由 Task 7/8 的快速集成测试（压缩心跳）先行证明；soak 文件虽在 Task 13 落地，其失败模式只会是"时序/资源"类，不会推翻已绿的结构性测试。执行者应在 Checkpoint B 之后、SPEC 定稿之前跑它，实测时延数据填入 SPEC 重连节。）

- [ ] **Step 2: 执行 soak** — Run: `bun run test:soak`
  Expected: 1 passed（约 10 min）。把结果（ping 次数、subscribeCount、时长）记到看板 `### 执行日志`。
- [ ] **Step 3: 终检** — Run: `bun run typecheck && bun test tests/unit tests/integration && bun run build && bun run check:dist && git status --porcelain`
  Expected: 全绿；工作区干净（所有任务已提交）。
- [ ] **Step 4: Commit** — `git add tests/soak/soak.test.ts && git commit -m "test: 10-minute soak proving keepalive and mid-run reconnect (AC2)"`

**Checkpoint C（收尾）** — 逐条复核 Global Constraints AC1–AC6：
- AC1 ← Task 7 transport.test + Task 9 cli.test（非零退出）。
- AC2 ← Task 13 soak 记录。
- AC3 ← Task 7 kicked 测试 + Task 8 kickedCount 可观测。
- AC4 ← Task 8 echo.test。
- AC5 ← Task 9 status 测试 + 全绿 gate。
- AC6 ← Task 11 check:dist + adapter 是唯一 SDK import 点（`grep -rl '@wecom/aibot-node-sdk' src/` 应只有 `src/transport/wecom-sdk-adapter.ts`）。
Run: `grep -rl '@wecom/aibot-node-sdk' src/` Expected: 仅 `src/transport/wecom-sdk-adapter.ts` 一行。

## 风险与缓解（显式）

- **SDK 实际行为与 .d.ts 注释不符**（认证错误传递通道、被踢后是否自动重连）：高风险，Task 7 集成测试先行实证，SPEC 措辞跟随实测（D2 评审条件）；若被踢后 SDK 不自动重连，adapter 在 `kicked` 事件里补 `stop()+start()` 自愈（改动只在 adapter 内，不违 AC6）。
- **GitHub Packages 发布端到端**（registry 可见性、token）在沙箱不可验：交付物为管道文件，真实发布验证列入 Human-Review 清单（decisions.md D8 已记）。
- **真实 WeCom 端 AC2/AC3/AC4 验证**需凭据：mock 服务端测试为等效证据，真实冒烟列入 Human-Review 清单（decisions.md D5 FLAGGED-FOR-HUMAN）。
- **`bun test` 对无测试目录的行为差异**：Task 1 Step 5 已含兜底（`tests/.gitkeep`）。
