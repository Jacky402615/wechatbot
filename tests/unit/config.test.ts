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
