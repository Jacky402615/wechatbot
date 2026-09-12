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
