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

test('statusText 封顶渲染（code-review F3）：超 20 项名单显示前 20 + 总数标记', () => {
  const many = Array.from({ length: 25 }, (_, i) => `user${i}`);
  const s = statusText({ connected: true, authenticated: true, admins: many, approved: [], groups: [], activeSessions: 0, inFlight: 0 });
  expect(s).toContain('管理员 (25)');
  expect(s).toContain('user0');
  expect(s).toContain('user19');
  expect(s).not.toContain('user20,');
  expect(s).toContain('…等共 25 项');
  const small = statusText({ connected: true, authenticated: true, admins: ['a', 'b'], approved: [], groups: [], activeSessions: 0, inFlight: 0 });
  expect(small).toContain('a, b');
  expect(small).not.toContain('…等共');
});

test('statusText 损坏档披露（code-review F4）', () => {
  const s = statusText({ connected: true, authenticated: true, admins: [], approved: [], groups: [], activeSessions: 2, corruptSessions: 3, inFlight: 0 });
  expect(s).toContain('活跃会话: 2（另有 3 个无法读取的会话档）');
  expect(statusText({ connected: true, authenticated: true, admins: [], approved: [], groups: [], activeSessions: 2, inFlight: 0 })).toContain('活跃会话: 2');
});
