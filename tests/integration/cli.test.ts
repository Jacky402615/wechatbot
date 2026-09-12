import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import { runCli } from '../../src/cli';
import { MockWecomServer } from '../helpers/mock-wecom-server';

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
    timeout: 45_000,   // 默认认证退避下 ~30s 才响亮失败（transport start-timeout 兜底），留余量
  });
  expect(r.status).not.toBe(0);
  expect(r.stderr.toString()).toMatch(/subscribe|auth|credential|启动失败/i);
  // 结构化 ERROR 留痕（feishubot #62）：JSONL 里必须能查到这次启动失败
  const logsDir = join(ws, '.bot', 'logs');
  const logText = readdirSync(logsDir).map((f) => readFileSync(join(logsDir, f!), 'utf8')).join('');
  expect(logText).toMatch(/"level":"error"/);
  await srv.stop();
}, 75_000);

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

test('前台 run 也持有 pidfile：运行中 status 报 connected，退出后 not running', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'wb-cli-'));
  const { loadWorkspace } = await import('../../src/config');
  loadWorkspace(ws);
  writeFileSync(join(ws, '.bot', '.env'), 'WECOM_BOT_ID=b\nWECOM_SECRET=good\n');
  writeFileSync(join(ws, '.bot', 'config.json'), JSON.stringify({ logLevel: 'info', heartbeatInterval: 500 }));
  const srv = new MockWecomServer();
  const { url } = await srv.start();
  const child = spawn('bun', ['src/cli.ts', 'run', '-r', ws], {
    env: { ...process.env, WECOM_WS_URL: url },
    stdio: 'ignore',
  });
  try {
    await waitUntil(async () => (await runCliOut(['status', '-r', ws])).includes('"connected": true'), 15_000);
  } finally {
    child.kill('SIGTERM');
    await new Promise<number>((r) => child.once('exit', (c) => r(c ?? -1)));
  }
  const after = await runCliOut(['status', '-r', ws]);
  expect(after).toMatch(/"running": false|not running/);
  await srv.stop();
}, 60_000);

test('start 对坏凭据：确认轮询等到子进程响亮退出后返回 1，并清理 pidfile', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'wb-cli-'));
  const { loadWorkspace } = await import('../../src/config');
  loadWorkspace(ws);
  writeFileSync(join(ws, '.bot', '.env'), 'WECOM_BOT_ID=b\nWECOM_SECRET=bad\n');
  const srv = new MockWecomServer({ authErrcode: 40001 });
  const { url } = await srv.start();
  const r = spawnSync('bun', ['src/cli.ts', 'start', '-r', ws], {
    env: { ...process.env, WECOM_WS_URL: url },
    timeout: 60_000,
  });
  expect(r.status).toBe(1);
  expect(r.stderr.toString()).toMatch(/未能确认连接|启动即退出|daemon-stderr/);
  expect(existsSync(join(ws, '.bot', 'gateway.pid'))).toBe(false);
  await srv.stop();
}, 90_000);

test('单网关契约：pidfile 显示已验证网关在跑时，run 拒绝启动', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'wb-cli-'));
  const { loadWorkspace } = await import('../../src/config');
  const { writePidFile } = await import('../../src/pid');
  loadWorkspace(ws);
  writeFileSync(join(ws, '.bot', '.env'), 'WECOM_BOT_ID=b\nWECOM_SECRET=s\n');
  writePidFile(join(ws, '.bot', 'gateway.pid'), process.pid);  // "另一个"已验证网关在跑
  const r = spawnSync('bun', ['src/cli.ts', 'run', '-r', ws], { timeout: 15_000 });  // 子进程 pid ≠ pidfile
  expect(r.status).toBe(1);
  expect(r.stderr.toString()).toMatch(/已有网关在运行/);
});

test('管理面独立于 config：config 损坏时 status/stop 仍工作；pidfile 损坏时 stop 拒绝清理', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'wb-cli-'));
  const { loadWorkspace } = await import('../../src/config');
  loadWorkspace(ws);
  writeFileSync(join(ws, '.bot', 'config.json'), '{corrupt');   // 损坏 config
  expect(await runCli(['status', '-r', ws])).toBe(0);           // 不抛、报告 not running
  expect(await runCli(['stop', '-r', ws])).toBe(0);
  writeFileSync(join(ws, '.bot', 'gateway.pid'), 'not-json');   // 损坏 pidfile
  const r = spawnSync('bun', ['src/cli.ts', 'stop', '-r', ws], { timeout: 15_000 });
  expect(r.status).toBe(1);                                     // 拒绝破坏性清理
  expect(existsSync(join(ws, '.bot', 'gateway.pid'))).toBe(true);
  // 启动面同样拒绝：损坏记录可能是活网关的，不得覆盖
  const r2 = spawnSync('bun', ['src/cli.ts', 'run', '-r', ws], { timeout: 15_000 });
  expect(r2.status).toBe(1);
  expect(r2.stderr.toString()).toMatch(/无法解析/);
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
