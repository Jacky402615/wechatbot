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
  expect(loadBotEnv(join(dir, '.bot'))).toEqual({ botId: 'b', secret: 's' });
});

test('loadBotEnv 缺失键抛错并指明键与路径', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-env-'));
  mkdirSync(join(dir, '.bot'), { recursive: true });
  writeFileSync(join(dir, '.bot', '.env'), 'WECOM_BOT_ID=b\n');
  expect(() => loadBotEnv(join(dir, '.bot'))).toThrow(/WECOM_SECRET.*\.env/);
});

test('loadBotEnv 允许空值（首启模板）；assertCredentials 拒绝空值', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-env-'));
  mkdirSync(join(dir, '.bot'), { recursive: true });
  writeFileSync(join(dir, '.bot', '.env'), 'WECOM_BOT_ID=\nWECOM_SECRET=\n');
  expect(loadBotEnv(join(dir, '.bot'))).toEqual({ botId: '', secret: '' });
  expect(() => assertCredentials({ botId: '', secret: 'x' }, join(dir, '.bot', '.env'))).toThrow(/WECOM_BOT_ID.*empty/);
  expect(() => assertCredentials({ botId: 'b', secret: 's' }, 'whatever')).not.toThrow();
});
