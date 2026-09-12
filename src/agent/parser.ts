import type { InboundTextMessage } from '../transport/types';

export interface StreamEvent { type: string; [k: string]: unknown }

export function parseStreamLine(line: string): StreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object' && typeof (parsed as StreamEvent).type === 'string') {
      return parsed as StreamEvent;
    }
    return null;
  } catch {
    return null;
  }
}

export function isTerminalEvent(e: StreamEvent): boolean {
  if (e.type === 'result' && e.subtype === 'tool_result') return false;
  return e.type === 'result' || e.type === 'error';
}

export function extractTextFromAssistant(e: StreamEvent): string | null {
  const content = (e as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: string }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string') {
      return (block as { text: string }).text;
    }
  }
  return null;
}

export function classifyControlRequest(e: StreamEvent): {
  type: 'auto_approve' | 'ask_user'; requestId: string; toolName?: string; input?: Record<string, unknown>;
} {
  const requestId = String(e['request_id'] ?? '');
  const request = e['request'] as StreamEvent | undefined;
  if (!request || (request as { subtype?: unknown }).subtype !== 'can_use_tool') {
    return { type: 'auto_approve', requestId };
  }
  const toolName = (request as { tool_name?: unknown }).tool_name as string | undefined;
  const input = (request as { input?: unknown }).input as Record<string, unknown> | undefined;
  if (toolName === 'AskUserQuestion') return { type: 'ask_user', requestId, toolName, input };
  return { type: 'auto_approve', requestId, toolName, input };
}

export interface AskQuestionView {
  question: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

export function extractAskUserQuestions(input: Record<string, unknown>): AskQuestionView[] {
  const questions = input['questions'] as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(questions)) return [];
  return questions.map((q) => ({
    question: typeof q['question'] === 'string' ? q['question'] : '',
    options: Array.isArray(q['options'])
      ? (q['options'] as Array<Record<string, unknown>>).map((o) => ({
          label: typeof o['label'] === 'string' ? o['label'] : '',
          description: typeof o['description'] === 'string' ? o['description'] : undefined,
        }))
      : undefined,
    multiSelect: q['multiSelect'] === true,
  }));
}

/** 扁平编号渲染：跨题连续编号（题1 选项 1..n，题2 选项 n+1..m）——与 parseNumericReply 同序同源 */
export function renderAskText(questions: AskQuestionView[]): string {
  const blocks: string[] = [];
  let n = 0;
  for (const q of questions) {
    if (!q.question) continue;
    const lines: string[] = [`❓ ${q.question}`];
    for (const o of q.options ?? []) {
      n += 1;
      lines.push(`${n}. ${o.label}${o.description ? `（${o.description}）` : ''}${q.multiSelect ? '（可多选）' : ''}`);
    }
    blocks.push(lines.join('\n'));
  }
  const multi = questions.some((q) => q.multiSelect);
  const footer = multi
    ? '（回复数字选择；多选用逗号分隔，如 1,3；也可以直接回复文字）'
    : '（回复数字选择，也可以直接回复文字）';
  return [...blocks, footer].join('\n\n');
}

export type AskReplyParse =
  | { kind: 'options'; answers: Record<string, string> }
  | { kind: 'free_text' }
  | { kind: 'invalid_numeric' };

/** 数字回复解析：`1` / `1,3`（半/全角逗号、顿号、空白容忍）。扁平编号确定性分配到所属题
 *  （跨题混合选择合法——D7 分歧记录）；单选题多项、越界、空文本 ⇒ invalid_numeric；
 *  非数字文本 ⇒ free_text；部分作答允许（未提及的题不入 answers——agent 补问）。 */
export function parseNumericReply(text: string, questions: AskQuestionView[]): AskReplyParse {
  const trimmed = (text ?? '').trim();
  if (trimmed === '') return { kind: 'invalid_numeric' };
  if (!/^[\d,，、\s]+$/.test(trimmed)) return { kind: 'free_text' };
  const nums = [...new Set(
    trimmed.split(/[,，、\s]+/).filter(Boolean).map((t) => Number.parseInt(t, 10)),
  )].sort((a, b) => a - b);
  // 扁平编号 → {题, 选项} 映射（与 renderAskText 同序生成）
  const flat: Array<{ q: AskQuestionView; optLabel: string }> = [];
  for (const q of questions) for (const o of q.options ?? []) flat.push({ q, optLabel: o.label });
  const picksByQuestion = new Map<AskQuestionView, string[]>();
  for (const n of nums) {
    if (!Number.isInteger(n) || n < 1 || n > flat.length) return { kind: 'invalid_numeric' };
    const hit = flat[n - 1]!;
    picksByQuestion.set(hit.q, [...(picksByQuestion.get(hit.q) ?? []), hit.optLabel]);
  }
  for (const [q, picks] of picksByQuestion) {
    if (q.multiSelect !== true && picks.length > 1) return { kind: 'invalid_numeric' };
  }
  const answers: Record<string, string> = {};
  for (const [q, picks] of picksByQuestion) {
    if (q.question) answers[q.question] = picks.join(', ');
  }
  return { kind: 'options', answers };
}

export function buildContextPreamble(m: { userId: string; chatKey: string; chatType: InboundTextMessage['chatType'] }): string {
  const chatName = m.chatType === 'single' ? m.userId : m.chatKey.slice('group:'.length);
  const kind = m.chatType === 'single' ? 'p2p' : 'group';
  return `[Context: sender=${m.userId}, userid=${m.userId}, chat=${chatName} (${kind})]\n\n`;
}

export function buildQueuedBatchPrompt(messages: string[]): string {
  if (messages.length <= 1) return messages[0] ?? '';
  const items = messages.map((m, i) => `【消息 ${i + 1}】\n${m}`).join('\n\n');
  return `用户在上一条任务处理期间，先后发来了 ${messages.length} 条排队消息（按时间顺序排列，后发的消息可能修正或取消先发的）。请按对话语义依次理解并处理：\n\n${items}`;
}

/** 字节安全截断：Buffer 视图上回退到 UTF-8 序列边界，预留标记字节数。O(n)。 */
export function truncateUtf8(text: string, maxBytes: number, marker = '…[截断]'): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  let end = Math.max(0, maxBytes - markerBytes);
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1; // 跳过续字节，落在首字节
  return buf.subarray(0, end).toString('utf8') + marker;
}
