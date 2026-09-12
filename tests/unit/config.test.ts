import { test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, statSync, chmodSync } from 'node:fs';
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

test('.env 权限：创建即 0600；已存在的宽松权限会被收紧', () => {
  const ws = freshWs();
  const { botDir } = loadWorkspace(ws);
  const envPath = join(botDir, '.env');
  expect(statSync(envPath).mode & 0o777).toBe(0o600);
  // 模拟历史遗留的宽松权限
  chmodSync(envPath, 0o644);
  loadWorkspace(ws);
  expect(statSync(envPath).mode & 0o777).toBe(0o600);
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

test('数值边界：0/负心跳与非整数被拒；-1 无限重连与正整数被接受', () => {
  const ws = freshWs();
  loadWorkspace(ws);
  const set = (v: unknown) => writeFileSync(join(ws, '.bot', 'config.json'), JSON.stringify({ heartbeatInterval: v }));
  set(0);        expect(() => loadWorkspace(ws)).toThrow(/heartbeatInterval/);
  set(-5000);    expect(() => loadWorkspace(ws)).toThrow(/heartbeatInterval/);
  set(1.5);      expect(() => loadWorkspace(ws)).toThrow(/heartbeatInterval/);
  set(5000);     expect(() => loadWorkspace(ws)).not.toThrow();
  const setRc = (v: unknown) => writeFileSync(join(ws, '.bot', 'config.json'), JSON.stringify({ maxReconnectAttempts: v }));
  setRc(-2);     expect(() => loadWorkspace(ws)).toThrow(/maxReconnectAttempts/);
  setRc(2.5);    expect(() => loadWorkspace(ws)).toThrow(/maxReconnectAttempts/);
  setRc(-1);     expect(() => loadWorkspace(ws)).not.toThrow();
  setRc(10);     expect(() => loadWorkspace(ws)).not.toThrow();
});

// ── W2：agent 层三新键（plan Task 1；缺省不填——默认值由 AgentManager 持有，config 只做校验） ──
test('W2 键缺省：三个键保持 undefined（默认值归 manager），不注入 config 对象', () => {
  const ws = freshWs();
  const { config } = loadWorkspace(ws);
  expect(config).toEqual({ logLevel: 'info' });
  expect(config.sessionIdleTtlMinutes).toBeUndefined();
  expect(config.claudeModel).toBeUndefined();
  expect(config.maxConcurrentTurns).toBeUndefined();
});

test('W2 键合法值生效（含 trim）', () => {
  const ws = freshWs();
  loadWorkspace(ws);
  writeFileSync(join(ws, '.bot', 'config.json'), JSON.stringify({
    session_idle_ttl_minutes: 30, claudeModel: '  glm-5.3  ', maxConcurrentTurns: 8,
  }));
  const { config } = loadWorkspace(ws);
  expect(config.sessionIdleTtlMinutes).toBe(30);
  expect(config.claudeModel).toBe('glm-5.3');
  expect(config.maxConcurrentTurns).toBe(8);
});

test('session_idle_ttl_minutes：非整数/<=0 被拒', () => {
  const ws = freshWs();
  loadWorkspace(ws);
  const set = (v: unknown) => writeFileSync(join(ws, '.bot', 'config.json'), JSON.stringify({ session_idle_ttl_minutes: v }));
  set(1.5);  expect(() => loadWorkspace(ws)).toThrow(/session_idle_ttl_minutes/);
  set(0);    expect(() => loadWorkspace(ws)).toThrow(/session_idle_ttl_minutes/);
  set(-5);   expect(() => loadWorkspace(ws)).toThrow(/session_idle_ttl_minutes/);
  set('60'); expect(() => loadWorkspace(ws)).toThrow(/session_idle_ttl_minutes/);
});

test('claudeModel：空串/纯空白/非字符串被拒', () => {
  const ws = freshWs();
  loadWorkspace(ws);
  const set = (v: unknown) => writeFileSync(join(ws, '.bot', 'config.json'), JSON.stringify({ claudeModel: v }));
  set('');   expect(() => loadWorkspace(ws)).toThrow(/claudeModel/);
  set('   ');expect(() => loadWorkspace(ws)).toThrow(/claudeModel/);
  set(42);   expect(() => loadWorkspace(ws)).toThrow(/claudeModel/);
});

test('maxConcurrentTurns：非整数/<=0 被拒', () => {
  const ws = freshWs();
  loadWorkspace(ws);
  const set = (v: unknown) => writeFileSync(join(ws, '.bot', 'config.json'), JSON.stringify({ maxConcurrentTurns: v }));
  set(0);    expect(() => loadWorkspace(ws)).toThrow(/maxConcurrentTurns/);
  set(-1);   expect(() => loadWorkspace(ws)).toThrow(/maxConcurrentTurns/);
  set(2.5);  expect(() => loadWorkspace(ws)).toThrow(/maxConcurrentTurns/);
});
