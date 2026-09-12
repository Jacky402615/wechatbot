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

test('id 字节上限（code-review R2-F2）：单 id 超 128 utf8 字节 ⇒ AccessError（/status 名单渲染的字节界）', () => {
  const dir = tmp(); write(dir, { approved: ['x'.repeat(128)] });   // 恰 128 字节——合法
  expect(new AccessGate(join(dir, '.bot', 'access.json')).load().tierOf('x'.repeat(128))).toBe('approved');
  write(dir, { approved: ['好'.repeat(65)] });                       // 65 × 3 字节 = 195 > 128
  expect(() => new AccessGate(join(dir, '.bot', 'access.json'))).toThrow(AccessError);
});
