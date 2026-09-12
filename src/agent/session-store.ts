import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface ChatSession {
  chatKey: string;
  chatType: 'single' | 'group';
  claudeSessionId: string | null;
  createdAt: string;
  lastActiveAt: string;
  status: 'active' | 'closed';
}

/** 以 UTF-8 字节计（plan 评审 R2-F7：字符数 ≠ 编码字节数）。预算按**临时文件名**算：
 *  base64url(160B) = 216 字符 + '.json' = 221 + 原子写 tmp 后缀('.'+12hex+'.tmp' = 17) = 238 < NAME_MAX(255)——
 *  终名与 tmp 名都不得越界。 */
const MAX_KEY_BYTES = 160;

export function chatKeyOf(m: { chatType: 'single' | 'group'; chatId?: string; userId: string }): string {
  if (m.chatType === 'group') {
    if (!m.chatId) throw new Error(`group chat requires chatId (userId=${m.userId})`);
    return `group:${m.chatId}`;
  }
  return `single:${m.userId}`;
}

/** 每 chat 会话档：base64url 文件名（不做 id 字符集假设）、原子写、0600。
 *  单写者由 W1 单网关契约（pidfile）保证。 */
export class SessionStore {
  constructor(private sessionsDir: string, private opts: { now?: () => Date; onTelemetryError?: (err: Error, what: string) => void } = {}) {
    mkdirSync(sessionsDir, { recursive: true });
  }

  /** 遥测面写失败（活动时间/resume id）默认重抛由调用方处置；构造注入钩子则 warn-and-continue */
  private telemetry(what: string, err: unknown): void {
    if (this.opts.onTelemetryError) {
      this.opts.onTelemetryError(err as Error, what);
    } else {
      throw err;
    }
  }

  private now(): Date { return this.opts.now ? this.opts.now() : new Date(); }

  private pathOf(chatKey: string): string {
    return join(this.sessionsDir, Buffer.from(chatKey, 'utf8').toString('base64url') + '.json');
  }

  get(chatKey: string): ChatSession | null {
    const keyBytes = Buffer.byteLength(chatKey, 'utf8');
    if (keyBytes > MAX_KEY_BYTES || keyBytes === 0) return null;
    let raw: string;
    try {
      raw = readFileSync(this.pathOf(chatKey), 'utf8');
    } catch (e) {
      // code-review C7：只有 ENOENT 是「无会话」；EACCES/EIO 等读取失败**上抛**（不吞 IO 错误）
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
    try {
      const s = JSON.parse(raw) as ChatSession;
      if (!s || typeof s !== 'object' || s.chatKey !== chatKey) return null;
      if (s.status === 'closed') return null;
      return s;
    } catch {
      return null; // 坏档（非法 JSON/形状不符）⇒ 当作无会话（严格丢，不修复）
    }
  }

  create(chatKey: string, chatType: 'single' | 'group'): ChatSession {
    const kb = Buffer.byteLength(chatKey, 'utf8');
    if (kb === 0 || kb > MAX_KEY_BYTES) {
      throw new Error(`invalid chatKey utf8 byte length: ${kb}`);
    }
    const now = this.now().toISOString();
    const s: ChatSession = { chatKey, chatType, claudeSessionId: null, createdAt: now, lastActiveAt: now, status: 'active' };
    this.write(s);
    return s;
  }

  /** 惰性 TTL 入口：active 且未过期 ⇒ 返回原档；否则（无档/过期/坏档）闭旧建新。 */
  resumable(chatKey: string, chatType: 'single' | 'group', ttlMs: number): ChatSession {
    const cur = this.get(chatKey);
    if (cur && !this.isStale(chatKey, ttlMs)) {
      this.updateActivity(chatKey);
      return cur;
    }
    if (cur) this.close(chatKey);
    return this.create(chatKey, chatType);
  }

  /** resume id 是 **核心续接状态**（AC2——code-review R2-C5）：写失败必须上抛
   *  （runTurn 外层失败生命周期接住报 turn_failed），绝不静默降级成「下次 fresh」。 */
  setClaudeSessionId(chatKey: string, id: string): void {
    const s = this.get(chatKey);
    if (!s) return;
    s.claudeSessionId = id;
    this.write(s);
  }

  /** 活动时间是 TTL 遥测面（W1 state 同款降级）：写失败留痕不抛。 */
  updateActivity(chatKey: string): void {
    const s = this.get(chatKey);
    if (!s) return;
    s.lastActiveAt = this.now().toISOString();
    try {
      this.write(s);
    } catch (e) {
      this.telemetry('updateActivity', e);
    }
  }

  isStale(chatKey: string, ttlMs: number): boolean {
    const s = this.get(chatKey);
    if (!s) return true;
    const t = Date.parse(s.lastActiveAt);
    if (!Number.isFinite(t)) return true;
    return this.now().getTime() - t > ttlMs;
  }

  close(chatKey: string): void {
    const s = this.get(chatKey);
    if (!s) return;
    this.write({ ...s, status: 'closed' });
  }

  /** /status 数据面：活动档计数（读目录 + 逐档 status 判定——记录极小，W2 D4 无启动清扫同因）。 */
  listActive(): number {
    let n = 0;
    for (const f of readdirSync(this.sessionsDir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const s = JSON.parse(readFileSync(join(this.sessionsDir, f), 'utf8')) as ChatSession;
        if (s && s.status === 'active') n += 1;
      } catch { /* 坏档不计数（get 同款严格丢语义） */ }
    }
    return n;
  }

  private write(s: ChatSession): void {
    const final = this.pathOf(s.chatKey);
    const tmp = `${final}.${randomBytes(6).toString('hex')}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, final);
  }
}
