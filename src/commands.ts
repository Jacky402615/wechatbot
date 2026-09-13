export interface ParsedCommand { name: string; args: string }

/** feishubot 同款：前导 /<name>，名字归一小写——/STOP 与 /stop 同分派。 */
export function parseCommand(text: string): ParsedCommand | null {
  const m = text.trim().match(/^\/([\w-]+)\s*([\s\S]*)$/);
  if (!m) return null;
  return { name: m[1]!.toLowerCase(), args: m[2]! };
}

/** 群 @-提及剥离（D3）：content trim 后须以 `@<mentionName>` 开头且带 token 边界
 *  （名字后是空白或串尾——@botbot 不得命中 @bot）；未配置名 ⇒ 恒 null（群帧全忽略）。 */
export function stripMention(content: string, mentionName: string | undefined): string | null {
  if (!mentionName) return null;
  const t = content.trimStart();
  if (!t.startsWith(`@${mentionName}`)) return null;
  const rest = t.slice(1 + mentionName.length);
  if (rest !== '' && !/^\s/.test(rest)) return null; // token 边界
  return rest.trim();
}

export const REJECTION_TEXT = '🔒 你尚未被授权使用此机器人，请联系管理员添加。';

export function helpText(): string {
  return [
    '可用命令:',
    '/new — 重置会话（中止当前回合并开启全新会话）',
    '/stop — 停止当前进行中的回合',
    '/status — 查看网关状态（仅管理员私聊）',
    '/help — 显示本帮助',
    '',
    '普通消息直接发送即可对话；群聊中请 @我。',
  ].join('\n');
}

/** enter_chat 欢迎语 = 欢迎 + 命令清单（AC4：welcome + command list）。 */
export function welcomeText(): string {
  return `👋 你好！我是智能助手。\n\n${helpText()}`;
}

export function statusText(snap: { connected: boolean; authenticated: boolean; admins: readonly string[]; approved: readonly string[]; groups: readonly string[]; activeSessions: number; corruptSessions?: number; inFlight: number }): string {
  const conn = snap.connected ? (snap.authenticated ? '已连接（已认证）' : '已连接（未认证）') : '未连接';
  // code-review F3：名单渲染封顶——合法但超大的 access 名单不得撑爆 20KB 内容上限（计数仍在）
  const CAP = 20;
  const renderList = (items: readonly string[]): string => {
    const shown = items.slice(0, CAP).join(', ') || '（无）';
    return items.length > CAP ? `${shown} …等共 ${items.length} 项` : shown;
  };
  const corrupt = snap.corruptSessions && snap.corruptSessions > 0 ? `（另有 ${snap.corruptSessions} 个无法读取的会话档）` : '';
  return [
    '📊 网关状态（快照）',
    `连接：${conn}`,
    `管理员 (${snap.admins.length}): ${renderList(snap.admins)}`,
    `授权用户 (${snap.approved.length}): ${renderList(snap.approved)}`,
    `授权群 (${snap.groups.length}): ${renderList(snap.groups)}`,
    `活跃会话: ${snap.activeSessions}${corrupt}`,
    `进行中回合: ${snap.inFlight}`,
  ].join('\n');
}
