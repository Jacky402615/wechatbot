#!/usr/bin/env node
// fake claude：按 FAKE_CLAUDE_SCENARIO 回放 stream-json。协议与真实 claude --print
// --input-format stream-json --output-format stream-json 一致（feishubot 生产实核）。
// 状态目录（FAKE_CLAUDE_STATE_DIR）追加写：
//   argv.jsonl   每进程一行 {argv, cwd, hasClaudecode, resumeId, pid, ts}
//   stdin.jsonl  每行一条收到的 stdin JSON 原文（user 消息 / control_response）
//   sessions.jsonl 每进程 emit 的 session_id
//   exit.jsonl   每进程退出记录 {pid, ts}——供「旧进程退出先于新 spawn」断言
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

const SCENARIO = process.env.FAKE_CLAUDE_SCENARIO ?? 'happy';
const DIR = process.env.FAKE_CLAUDE_STATE_DIR;
if (!DIR) { process.stderr.write('FAKE_CLAUDE_STATE_DIR required\n'); process.exit(2); }

const argv = process.argv.slice(2); // argsPrefix 之后的全部参数（即 claude 的参数）
const resumeIdx = argv.indexOf('--resume');
const resumeId = resumeIdx >= 0 ? argv[resumeIdx + 1] : null;
appendFileSync(join(DIR, 'argv.jsonl'), JSON.stringify({
  argv, cwd: process.cwd(), hasClaudecode: 'CLAUDECODE' in process.env, resumeId,
  pid: process.pid, ts: Date.now(),
}) + '\n');
process.on('exit', () => {
  appendFileSync(join(DIR, 'exit.jsonl'), JSON.stringify({ pid: process.pid, ts: Date.now() }) + '\n');
});

const sessionId = resumeId ?? `fake-sid-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const logStdin = (line) => appendFileSync(join(DIR, 'stdin.jsonl'), line + '\n');

function emitInit() {
  appendFileSync(join(DIR, 'sessions.jsonl'), sessionId + '\n');
  out({ type: 'system', subtype: 'init', session_id: sessionId });
}
const assistant = (text) => out({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', content: [{ type: 'text', text }] } });
const result = (extra = {}) => out({ type: 'result', subtype: 'success', result: 'done', session_id: sessionId, ...extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readUserLine() {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    logStdin(line);
    try {
      const obj = JSON.parse(line);
      if (obj?.type === 'user') return obj;
      if (obj?.type === 'control_response') return obj; // ask 场景的作答回路
    } catch { /* 坏行忽略 */ }
  }
  return null;
}

const ASK_INPUT = {
  questions: [
    { question: '选哪个方案？', options: [{ label: '甲' }, { label: '乙' }] },
  ],
};
const ASK_MULTI_INPUT = {
  questions: [
    { question: '用哪个库？', options: [{ label: 'bun' }, { label: 'node' }] },
    { question: '要不要日志？', options: [{ label: '要' }, { label: '不要' }], multiSelect: true },
  ],
};

switch (SCENARIO) {
  case 'happy': {
    await readUserLine();
    emitInit();
    assistant('这是假回复：处理完成。');
    result();
    break;
  }
  case 'deltas': {
    await readUserLine();
    emitInit();
    assistant('第一段。');
    assistant('第二段。');
    assistant('第三段。');
    result();
    break;
  }
  case 'ask':
  case 'ask-multi': {
    await readUserLine();
    emitInit();
    assistant('先确认一下：');
    out({
      type: 'control_request', request_id: 'cr-1',
      request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: SCENARIO === 'ask' ? ASK_INPUT : ASK_MULTI_INPUT },
    });
    const resp = await readUserLine(); // 等作答（control_response）
    if (resp?.type !== 'control_response') { process.exit(1); }
    assistant(`已收到选择，继续执行（request_id=${resp.response?.request_id ?? '?'}）。`);
    result();
    break;
  }
  case 'no-output': {
    emitInit();
    await sleep(120_000); // 永不产出——等被杀（超时护栏测试用压缩 turnTimeoutMs）
    process.exit(9);
    break;
  }
  case 'slow-output': {
    // 晚输出对抗样本：延迟 FAKE_CLAUDE_DELAY_MS 后才产出（默认 500ms）——
    // 配压缩 turnTimeoutMs 验证「deadline 先到 ⇒ 杀 + turn_failed(timeout)，无迟到流活动」
    await readUserLine();
    emitInit();
    await sleep(Number.parseInt(process.env.FAKE_CLAUDE_DELAY_MS ?? '500', 10));
    assistant('迟到的输出。');
    result();
    break;
  }
  case 'ignore-signals': {
    // 超时护栏的对抗样本：忽略 SIGINT/SIGTERM——验证收割梯子升级到 SIGKILL
    process.on('SIGINT', () => process.stderr.write('ignored SIGINT\n'));
    process.on('SIGTERM', () => process.stderr.write('ignored SIGTERM\n'));
    emitInit();
    await sleep(120_000);
    process.exit(9);
    break;
  }
  case 'resume-not-found': {
    if (resumeId) {
      emitInit();
      out({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['No conversation found'], session_id: sessionId });
    } else {
      await readUserLine();
      emitInit();
      assistant('新会话回复。');
      result();
    }
    break;
  }
  case 'crash': {
    process.stderr.write('fake claude crashed\n');
    process.exit(1);
    break;
  }
  case 'garbage': {
    emitInit();
    process.stdout.write('not-json\n');
    process.stdout.write('{"type":"weird"}\n');
    process.exit(0); // EOF 且无终态事件
    break;
  }
  default: {
    process.stderr.write(`unknown scenario ${SCENARIO}\n`);
    process.exit(2);
  }
}
