import { test, expect } from 'bun:test';
import {
  parseStreamLine, isTerminalEvent, extractTextFromAssistant, classifyControlRequest,
  extractAskUserQuestions, renderAskText, parseNumericReply, buildContextPreamble,
  buildQueuedBatchPrompt, truncateUtf8,
} from '../../src/agent/parser';

const TWO_Q = [
  { question: '用哪个库？', options: [{ label: 'bun' }, { label: 'node' }] },
  { question: '要不要日志？', options: [{ label: '要' }, { label: '不要' }], multiSelect: true },
];

test('parseStreamLine：合法 JSON 对象放行；空行/非 JSON/非对象拒绝', () => {
  expect(parseStreamLine('{"type":"result"}')!.type).toBe('result');
  expect(parseStreamLine('')).toBeNull();
  expect(parseStreamLine('not json')).toBeNull();
  expect(parseStreamLine('[1,2]')).toBeNull();
});

test('isTerminalEvent：result(非 tool_result)/error 终态；tool_result 非终态', () => {
  expect(isTerminalEvent({ type: 'result', subtype: 'success' })).toBe(true);
  expect(isTerminalEvent({ type: 'error' })).toBe(true);
  expect(isTerminalEvent({ type: 'result', subtype: 'tool_result' })).toBe(false);
  expect(isTerminalEvent({ type: 'assistant' })).toBe(false);
});

test('extractTextFromAssistant：取第一个 text block；非数组 content 拒绝', () => {
  const e = { type: 'assistant', message: { content: [{ type: 'thinking' }, { type: 'text', text: '答案' }] } };
  expect(extractTextFromAssistant(e)).toBe('答案');
  expect(extractTextFromAssistant({ type: 'assistant', message: { content: 'plain' } })).toBeNull();
});

test('classifyControlRequest：can_use_tool+AskUserQuestion ⇒ ask_user；其余 auto_approve', () => {
  const ask = { type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: {} } };
  expect(classifyControlRequest(ask)).toMatchObject({ type: 'ask_user', requestId: 'r1' });
  const bash = { type: 'control_request', request_id: 'r2', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} } };
  expect(classifyControlRequest(bash).type).toBe('auto_approve');
});

test('extractAskUserQuestions：字段归一；questions 缺失返回 []', () => {
  const qs = extractAskUserQuestions({ questions: [{ question: 'Q', options: [{ label: 'a', description: 'd' }], multiSelect: true }] });
  expect(qs).toEqual([{ question: 'Q', options: [{ label: 'a', description: 'd' }], multiSelect: true }]);
  expect(extractAskUserQuestions({})).toEqual([]);
});

test('renderAskText：扁平编号跨题 + multiSelect 注记 + 底部回复指引', () => {
  const text = renderAskText(TWO_Q);
  expect(text).toContain('1. bun');
  expect(text).toContain('2. node');
  expect(text).toContain('3. 要（可多选）');
  expect(text).toContain('4. 不要');
  expect(text).toMatch(/回复数字/);
  expect(text).toContain('1,3');
});

test('parseNumericReply：单选/多选/跨题分配/全角逗号与顿号', () => {
  expect(parseNumericReply('1', TWO_Q)).toEqual({ kind: 'options', answers: { '用哪个库？': 'bun' } });
  expect(parseNumericReply('2', TWO_Q)).toEqual({ kind: 'options', answers: { '用哪个库？': 'node' } });
  expect(parseNumericReply(' 1,3 ', TWO_Q)).toEqual({ kind: 'options', answers: { '用哪个库？': 'bun', '要不要日志？': '要' } });
  expect(parseNumericReply('3、4', TWO_Q)).toEqual({ kind: 'options', answers: { '要不要日志？': '要, 不要' } });
});

test('parseNumericReply：非数字 ⇒ free_text；越界/单选多挑/空 ⇒ invalid_numeric', () => {
  expect(parseNumericReply('用 bun 吧', TWO_Q).kind).toBe('free_text');
  expect(parseNumericReply('5', TWO_Q).kind).toBe('invalid_numeric');
  expect(parseNumericReply('0', TWO_Q).kind).toBe('invalid_numeric');
  expect(parseNumericReply('1,2', TWO_Q).kind).toBe('invalid_numeric'); // 第一题非 multiSelect 却两项
  expect(parseNumericReply('', TWO_Q).kind).toBe('invalid_numeric');
});

test('parseNumericReply：部分作答允许（未提及的题不入 answers）', () => {
  expect(parseNumericReply('3', TWO_Q)).toEqual({ kind: 'options', answers: { '要不要日志？': '要' } });
});

test('buildContextPreamble：单聊 p2p / 群聊 group，键序 sender,userid,chat', () => {
  expect(buildContextPreamble({ userId: 'u9', chatKey: 'single:u9', chatType: 'single' }))
    .toBe('[Context: sender=u9, userid=u9, chat=u9 (p2p)]\n\n');
  expect(buildContextPreamble({ userId: 'u9', chatKey: 'group:wr1', chatType: 'group' }))
    .toBe('[Context: sender=u9, userid=u9, chat=wr1 (group)]\n\n');
});

test('buildQueuedBatchPrompt：单条透传；多条带框架', () => {
  expect(buildQueuedBatchPrompt(['x'])).toBe('x');
  expect(buildQueuedBatchPrompt([])).toBe('');
  const two = buildQueuedBatchPrompt(['a', 'b']);
  expect(two).toContain('2 条排队消息');
  expect(two).toContain('【消息 1】\na');
  expect(two).toContain('【消息 2】\nb');
});

test('truncateUtf8：字节预算内原样；超限截断不切代理对且带标记', () => {
  expect(truncateUtf8('abc', 10)).toBe('abc');
  const ascii = 'a'.repeat(100);
  const out = truncateUtf8(ascii, 20);
  expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(20);
  expect(out).toContain('…[截断]');
  const cjk = '汉'.repeat(50); // 每字 3 字节
  const out2 = truncateUtf8(cjk, 20);
  expect(Buffer.byteLength(out2, 'utf8')).toBeLessThanOrEqual(20);
  expect(out2.endsWith('…[截断]')).toBe(true);
  expect(out2.slice(0, out2.indexOf('…[截断]'))).not.toContain('�');
  const emoji = '😀'.repeat(30); // 每个代理对 4 字节
  const out3 = truncateUtf8(emoji, 21);
  expect(Buffer.byteLength(out3, 'utf8')).toBeLessThanOrEqual(21);
  expect(out3.slice(0, out3.indexOf('…[截断]'))).not.toContain('�'); // 不切代理对
});
