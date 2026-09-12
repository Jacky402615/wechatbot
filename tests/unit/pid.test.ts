import { test, expect } from 'bun:test';
import { parseStartTime, processStartTime, isPidAlive, isOurProcess } from '../../src/pid';

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

test('isOurProcess：匹配自身 true；startedAt 缺失/不匹配/死 pid 一律 false', () => {
  const mine = processStartTime(process.pid);
  expect(mine).not.toBe(null);
  expect(isOurProcess({ pid: process.pid, startedAt: mine })).toBe(true);
  expect(isOurProcess({ pid: process.pid, startedAt: null })).toBe(false);      // 宁可拒判，不盲杀
  expect(isOurProcess({ pid: process.pid, startedAt: (mine ?? 0) + 12345 })).toBe(false); // pid 复用形态
  expect(isOurProcess({ pid: 2 ** 22, startedAt: 42 })).toBe(false);            // 死 pid
});
