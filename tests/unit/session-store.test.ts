import { test, expect } from 'bun:test';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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

test('resumable：首建 → TTL 内同键同档可续；超 TTL（自末次活动起算）换新档', () => {
  const { store, advance } = makeStore(60_000);
  const s1 = store.resumable('single:u1', 'single', 60_000);
  expect(s1.claudeSessionId).toBeNull();
  store.setClaudeSessionId('single:u1', 'sid-1');
  store.updateActivity('single:u1');
  advance(30_000);                             // 空闲 30s < TTL
  const s2 = store.resumable('single:u1', 'single', 60_000);
  expect(s2.claudeSessionId).toBe('sid-1');   // TTL 内 resume 同档（且刷新活动时间）
  advance(61_000);                             // 自末次活动（s2 的 updateActivity）起空闲 61s > TTL
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
  expect(statSync(full).mode & 0o777).toBe(0o600); // 0600
  expect(files.some((f) => f.includes('.tmp'))).toBe(false);
  expect((JSON.parse(readFileSync(full, 'utf8')) as { chatKey: string }).chatKey).toBe('single:u1');
});

test('读取权限失败（EACCES）上抛而非当作无会话（code-review C7——不吞 IO 错误）', () => {
  const { dir, store } = makeStore();
  store.resumable('single:u1', 'single', 60_000);
  const f = Buffer.from('single:u1', 'utf8').toString('base64url') + '.json';
  chmodSync(join(dir, 'sessions', f), 0o000);
  expect(() => store.get('single:u1')).toThrow();
  chmodSync(join(dir, 'sessions', f), 0o600); // 还原，避免 tmp 清理告警
});

test('坏档（非法 JSON）⇒ resumable 当作无会话新建，不抛', () => {
  const { dir } = makeStore();
  const f = Buffer.from('single:u1', 'utf8').toString('base64url') + '.json';
  writeFileSync(join(dir, 'sessions', f), '{broken');
  const store = new SessionStore(join(dir, 'sessions'));
  const s = store.resumable('single:u1', 'single', 60_000);
  expect(s.claudeSessionId).toBeNull();
});

test('close 后 get 返回 null（active 视图）；chatKey 超长拒绝（160 字节上限——按字节计，含 tmp 后缀预算）', () => {
  const { store } = makeStore();
  store.resumable('single:u1', 'single', 60_000);
  store.close('single:u1');
  expect(store.get('single:u1')).toBeNull();
  store.resumable('x'.repeat(160), 'single', 60_000); // 160 ASCII 字节 = 边界内可建（含原子写 tmp 后缀）
  expect(() => store.resumable('x'.repeat(161), 'single', 60_000)).toThrow(/chatKey/);
  expect(() => store.resumable('汉'.repeat(54), 'single', 60_000)).toThrow(/chatKey/); // 54 CJK 字 = 162 字节 > 160
});

test('listActive：损坏档计入 corrupt（code-review F4）——active 与披露面分离', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-ss-corrupt-'));
  const store = new SessionStore(join(dir, 'sessions'));
  store.create('single:u1', 'single');
  store.create('single:u2', 'single');
  writeFileSync(join(dir, 'sessions', Buffer.from('single:u3', 'utf8').toString('base64url') + '.json'), 'not-json{');
  expect(store.listActive()).toEqual({ active: 2, corrupt: 1 });
  store.close('single:u1');
  expect(store.listActive()).toEqual({ active: 1, corrupt: 1 });
});

test('listActive 形状坏档（code-review R2-F3）：合法 JSON 但非 ChatSession 形状同计 corrupt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-ss-shape-'));
  const store = new SessionStore(join(dir, 'sessions'));
  store.create('single:u1', 'single');
  writeFileSync(join(dir, 'sessions', Buffer.from('single:u2', 'utf8').toString('base64url') + '.json'), '{}');            // 缺 chatKey/status
  writeFileSync(join(dir, 'sessions', Buffer.from('single:u3', 'utf8').toString('base64url') + '.json'), '{"chatKey":"k","status":"weird"}'); // 未知 status
  expect(store.listActive()).toEqual({ active: 1, corrupt: 2 });
});
