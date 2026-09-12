import { readFileSync } from 'node:fs';
import { ConfigError } from './config';

export type AccessTier = 'admin' | 'approved' | 'rejected' | 'unknown';

export interface AccessState {
  admin: string[];
  approved: string[];
  rejected: string[];
  groups: string[];
}

/** 帧内不可变快照（plan 评审 R1-F2）：一次入站帧 load() 一次，gate/命令/status 共用同一版本。 */
export interface AccessSnapshot {
  tierOf(userId: string): AccessTier;
  groupAllowed(chatId: string): boolean;
  readonly admin: readonly string[];
  readonly approved: readonly string[];
  readonly rejected: readonly string[];
  readonly groups: readonly string[];
}

/** plan 评审 R3-F1：ConfigError 子类——启动失败面与 W1/W2 配置错误同契约（统一 instanceof 消费）。 */
export class AccessError extends ConfigError {}

const KEYS = ['admin', 'approved', 'rejected', 'groups'] as const;

/** 严格形状校验：未知键、非字符串数组、空串、列表内重复、单 id 超 128 字节、总条目超 1000
 *  ⇒ AccessError（W1 严格配置同构；字节与条目双界使逐帧同步解析的每帧开销有确定性上界——
 *  PR-review P3：热重读不得威胁 enter_chat 5s 窗；Set 去重/成员判定——O(n)） */
const MAX_ID_BYTES = 128;
const MAX_TOTAL_ENTRIES = 1000;

export function parseAccess(text: string, path: string): AccessState {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch (e) {
    throw new AccessError(`invalid JSON in ${path}: ${(e as Error).message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AccessError(`access file must be a JSON object: ${path}`);
  }
  const unknownKeys = Object.keys(raw).filter((k) => !KEYS.includes(k as (typeof KEYS)[number]));
  if (unknownKeys.length > 0) {
    throw new AccessError(`unknown key(s) ${unknownKeys.join(',')} in ${path} (allowed: ${KEYS.join(',')})`);
  }
  const state = { admin: [], approved: [], rejected: [], groups: [] } as AccessState;
  let total = 0;
  for (const key of KEYS) {
    const v = raw[key];
    if (v === undefined) continue;
    if (!Array.isArray(v)) throw new AccessError(`${key} must be a string array in ${path}`);
    const seen = new Set<string>();
    for (const id of v) {
      if (typeof id !== 'string' || id.trim() === '') throw new AccessError(`${key} entries must be non-empty strings in ${path}`);
      const trimmed = id.trim();
      if (seen.has(trimmed)) throw new AccessError(`duplicate entry "${trimmed}" in ${key} of ${path}`);
      seen.add(trimmed);
      if (Buffer.byteLength(trimmed, 'utf8') > MAX_ID_BYTES) throw new AccessError(`entry in ${key} exceeds ${MAX_ID_BYTES} utf8 bytes in ${path}`);
      total += 1;
      if (total > MAX_TOTAL_ENTRIES) throw new AccessError(`access file exceeds ${MAX_TOTAL_ENTRIES} total entries in ${path}`);
    }
    state[key] = [...seen];
  }
  return state;
}

const snapshotOf = (state: AccessState): AccessSnapshot => {
  // Set 成员判定（PR-review P3）：1000 条目帽下的确定性 O(1) 查询
  const admin = new Set(state.admin);
  const rejected = new Set(state.rejected);
  const approved = new Set(state.approved);
  const groups = new Set(state.groups);
  return {
    // tier 优先级 admin > rejected > approved（approved+rejected 冲突 ⇒ deny 优先，D2）
    tierOf(userId) {
      if (admin.has(userId)) return 'admin';
      if (rejected.has(userId)) return 'rejected';
      if (approved.has(userId)) return 'approved';
      return 'unknown';
    },
    groupAllowed(chatId) { return groups.has(chatId); },
    admin: [...state.admin],
    approved: [...state.approved],
    rejected: [...state.rejected],
    groups: [...state.groups],
  };
};

/** 每个入站事件 load() 一次；热重读失败沿用 last-known-good + onError（fail-visible，D2）。 */
export class AccessGate {
  private state: AccessState;

  constructor(private accessPath: string, private opts: { onError?: (err: Error) => void } = {}) {
    let text: string;
    try {
      text = readFileSync(accessPath, 'utf8');
    } catch (e) {
      // ENOENT/权限等读失败一律 AccessError（plan 评审 R2-F1）——启动响亮、类型如一
      throw new AccessError(`cannot read ${accessPath}: ${(e as Error).message}`);
    }
    this.state = parseAccess(text, accessPath); // 启动损坏上抛
  }

  load(): AccessSnapshot {
    try {
      this.state = parseAccess(readFileSync(this.accessPath, 'utf8'), this.accessPath);
    } catch (e) {
      this.opts.onError?.(e as Error);
    }
    return snapshotOf(this.state);
  }
}
