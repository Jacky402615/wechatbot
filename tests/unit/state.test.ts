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
  const s = sample();
  writeState(dir, s);
  expect(readState(dir)).toEqual(s);
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
