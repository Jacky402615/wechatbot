# Attachments: Media Decrypt + Download Implementation Plan

**Goal:** wechatbot W4——单聊入站 image/file/voice/video 经 SDK 内建 `downloadFile(url, aeskey)` 下载解密落盘 `.bot/uploads/YYYY-MM-DD/`（30 天清理），prompt 组装携带本地路径（voice/video 显式声明不可解析），下载失败回站内短错误。

**Architecture:** 新增纯模块 `src/media.ts`（`MediaStore` 保存/消毒/剪枝 + attachment-note 纯函数）；transport 事件面增统一 `mediaMessage` 事件与 `downloadFile` 端口（adapter 委托 SDK，Q12——零自研 crypto）；`AgentHandler.onMedia` 薄编排：群守卫 → access gate（未授权不下载）→ 过期 ask 判定 → 下载落盘 → note → submit。下载/解密 throw 走关键终帧错误（AC4 硬保证）；oversize/空/落盘失败降级 note（never silent drop）。

**Tech Stack:** TypeScript (bun runtime)、`@wecom/aibot-node-sdk@1.0.7`（`WSClient.downloadFile`：axios arraybuffer + AES-256-CBC 解密，IV=key[:16]，PKCS#7 32 字节块）、bun:test（unit 桩端口 + integration 本地 HTTP 加密文件服务端真解密）。

**Spec:** `docs/issues/4/decisions.md`

## Global Constraints

- AC1: 单聊图片解密后落 `uploads/YYYY-MM-DD/`；prompt 携带该路径；note 指示 agent 用 Read 工具查看（spec S4）。
- AC2: 文件同 AC1，100 MB 平台帽内（spec S5）。
- AC3: 语音/视频归档落盘；prompt 显式声明内容不可解析（spec S6）。
- AC4: 过期 URL / bad aeskey 入站 ⇒ 站内短错误回执（关键终帧路径，非静默）。
- Q12：只用 SDK 内建下载/解密——产品路径零自研 crypto；测试侧加密镜像仅存 `tests/helpers/`。
- 下载时机硬约束：过 access gate 后立即下载（URL 5 分钟窗）——排队/回合失败不吞噬下载窗；已授权附件先物化后消费（D5）。
- 分派序（W3 序的媒体变体，D4）：群帧守卫（群媒体 debug 忽略——平台 single-chat only）→ access gate（非 admin/approved ⇒ 拒绝文案，**零下载**）→ `expireStaleAsk` → **不喂 `answerPendingAsk`**（媒体不作答）→ 下载 → submit（busy 排队，批量回合合流）。
- 文件名消毒（D6）：剥路径分隔符/控制字符/换行（prompt 注入防线）、扩展保留后截断 ~120 UTF-8 字节、`<safeMsgid>-` 前缀（**msgid 本身也是平台输入——字符集白名单 `[^A-Za-z0-9._-]→_`、≤64 字符**，碰撞安全 + 同 msgid 重投递幂等覆盖）、缺名 fallback `<safeMsgid>-<kind>.<ext>`（jpg/bin/amr/mp4）；日期目录取本地时区。
- 失败面（D8）：**缺 url 或缺 aeskey 的媒体帧（协议异常）⇒ 与下载失败同面**——`criticalFinal` 短错误 + ERROR 日志 + 不下载不 spawn（长连接模式媒体恒加密，无 key 的密文不得当可解析附件落盘）；下载/解密 throw ⇒ 同 `criticalFinal` 路径；oversize（>100 MB，SDK 全量缓冲后判定）/空 buffer/落盘失败 ⇒ 降级 note 入 prompt + 日志，回合照跑；任何路径不得静默丢。
- 回合级不去重（与 text 路径一致）：msgid 排重是平台责任（`aibot_msg_callback` 协议「唯一性标志，用于事件排重」）；文件级幂等覆盖已保住磁盘不重复——同 msgid 重投递产生重复回合是**接受并文档化的既有行为**（W1–W3 text 同构）。
- 30 天清理（D9）：启动 + 每 24 h `unref()` 定时；逐目录 try/catch，失败仅日志；非日期形条目不动。
- 忽略 SDK `VoiceContent.content`（ASR）——issue 判 voice 不可解析，转写 v2+（D7）；群媒体帧与 `message.mixed` 可见地忽略（debug 日志；mixed = known gap + follow-up issue，D10）。
- 回归红线：W1–W3 全量测试保持绿（`bun test` 全量）；`WeComTransport` 接口扩员同 commit 迁移 `FakeTransport`（W3 R2-F2 教训）。
- Agent 行为面（AC1「agent references it correctly」的真机侧）：mock 集成锁定 prompt 契约（stdin.jsonl 携带路径 note）；真实 agent 读图行为列 Human-Review 手工清单。

## Tasks

### Task 1: `src/media.ts` — MediaStore 纯模块 + attachment-note 纯函数

**Files:**
- Create: `src/media.ts`
- Test: `tests/unit/media.test.ts`

**Interfaces:**
- Consumes: `MediaKind`（定义于本文件并 re-export 供 transport/types 使用——见 Task 2 import 方向：`transport/types.ts` 从 `../media` import type）
- Produces:
  - `export type MediaKind = 'image' | 'file' | 'voice' | 'video'`
  - `export const MAX_MEDIA_BYTES = 100 * 1024 * 1024`（D8 防御帽）
  - `export function safeMsgid(msgid: string): string`（字符集白名单 `[^A-Za-z0-9._-]` → `_`、≤64 字符——msgid 是平台输入，不得直入路径/prompt）
  - `export function sanitizeName(msgid: string, rawFilename: string | undefined, kind: MediaKind): string`（D6——返回最终落盘名 `<safeMsgid>-<base>.<ext>`）
  - `export class MediaStore { constructor(uploadsDir: string, opts?: { now?: () => Date; onError?: (err: Error, what: string) => void; removeDir?: (dir: string) => void; readdir?: (dir: string) => string[] }); save(kind: MediaKind, msgid: string, buffer: Buffer, filename?: string): { absPath: string; bytes: number }; prune(now?: Date): string[]; startPruneTimer(): void }`（`removeDir`/`readdir` 测试注入——失败面确定性覆盖）
  - `export function attachmentNote(kind: MediaKind, absPath: string, bytes: number): string`
  - `export function degradedNote(kind: MediaKind, reason: 'empty' | 'oversize' | 'save-failed'): string`

- [ ] **Step 1: Write the failing test**（`tests/unit/media.test.ts`）

```ts
import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MediaStore, sanitizeName, safeMsgid, attachmentNote, degradedNote, MAX_MEDIA_BYTES } from '../../src/media';

const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'wb-media-')); mkdirSync(join(d, 'uploads'), { recursive: true }); return d; };
const localDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

test('safeMsgid：字符集白名单 + 长度帽——穿越/控制字符/超长 msgid 不得入路径', () => {
  expect(safeMsgid('mm1')).toBe('mm1');
  expect(safeMsgid('../evil')).toBe('.._evil');            // / → _
  expect(safeMsgid('a\nb')).toBe('a_b');                    // 控制字符 → _
  expect(safeMsgid('x'.repeat(300)).length).toBeLessThanOrEqual(64);
  expect(safeMsgid('')).toBe('_');                          // 空 ⇒ 占位（不产生空前缀）
});

test('sanitizeName：正常名保留（safeMsgid 前缀）；路径穿越/控制字符/换行剥除；空白折叠；截断保扩展', () => {
  expect(sanitizeName('msg1', 'report.pdf', 'file')).toBe('msg1-report.pdf');
  expect(sanitizeName('../evil', 'report.pdf', 'file')).toBe('.._evil-report.pdf');      // 恶意 msgid 消毒后入前缀
  expect(sanitizeName('msg1', '../../etc/passwd', 'file')).toBe('msg1-etcpasswd.bin');  // 分隔符剥除（无 1-8 字母数字尾 ext ⇒ fallback ext）
  expect(sanitizeName('msg1', 'a/b\\c.png', 'image')).toBe('msg1-abc.png');
  expect(sanitizeName('msg1', 'bad\nname\r.png', 'image')).toBe('msg1-badname.png');    // 换行剥除（注入防线）
  expect(sanitizeName('msg1', 'a \t b.docx', 'file')).toBe('msg1-a b.docx');            // 空白折叠
  const long = 'x'.repeat(300);
  const out = sanitizeName('msg1', `${long}.pdf`, 'file');
  expect(out.startsWith('msg1-')).toBe(true);
  expect(out.endsWith('.pdf')).toBe(true);                                              // 截断保扩展
  expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(120);                      // 全名（含前缀/扩展）≤ 120 UTF-8 字节
  expect(sanitizeName('msg1', undefined, 'image')).toBe('msg1-image.jpg');              // fallback：<safeMsgid>-<kind>.<ext>
  expect(sanitizeName('msg1', undefined, 'voice')).toBe('msg1-voice.amr');
  expect(sanitizeName('msg1', undefined, 'video')).toBe('msg1-video.mp4');
  expect(sanitizeName('msg1', undefined, 'file')).toBe('msg1-file.bin');
  expect(sanitizeName('msg1', '   ', 'file')).toBe('msg1-file.bin');                    // 消毒后空 ⇒ fallback
});

test('MediaStore.save：本地日期目录 + msgid 幂等覆盖 + 返回绝对路径与字节数', () => {
  const dir = tmp();
  const store = new MediaStore(join(dir, 'uploads'));
  const s1 = store.save('image', 'm1', Buffer.from('hello'), 'photo.jpg');
  expect(s1.absPath).toBe(join(dir, 'uploads', localDate(new Date()), 'm1-photo.jpg'));
  expect(s1.bytes).toBe(5);
  expect(existsSync(s1.absPath)).toBe(true);
  expect(readFileSync(s1.absPath).toString()).toBe('hello');
  store.save('image', 'm1', Buffer.from('overwritten'), 'photo.jpg');                   // 同 msgid 重投递
  expect(readFileSync(s1.absPath).toString()).toBe('overwritten');
  expect(readdirSync(join(dir, 'uploads', localDate(new Date()))).length).toBe(1);      // 幂等覆盖非新增
});

test('MediaStore.prune：30 天界（恰 30 天保留、31 天删除）；非日期条目不动；失败隔离（removeDir 注入）', () => {
  const dir = tmp();
  const now = new Date(2026, 8, 13);                                                    // 本地 2026-09-13 00:00
  const mk = (name: string) => mkdirSync(join(dir, 'uploads', name), { recursive: true });
  mk('2026-08-13'); mk('2026-08-14'); mk('2026-09-12'); mk('not-a-date');
  const store = new MediaStore(join(dir, 'uploads'));
  const removed = store.prune(now);
  expect(removed).toEqual(['2026-08-13']);                                              // 31 天删；2026-08-14 恰 30 天保留（≥30 天可用性）
  expect(existsSync(join(dir, 'uploads', '2026-08-14'))).toBe(true);
  expect(existsSync(join(dir, 'uploads', '2026-09-12'))).toBe(true);                    // 29 天保留
  expect(existsSync(join(dir, 'uploads', 'not-a-date'))).toBe(true);                    // 非日期条目不动
  expect(store.prune(now)).toEqual([]);                                                 // 幂等：已删目录不重复报告
  // 失败隔离（确定性注入，非 chmod——root 环境不失效）：removeDir 对特定目录抛错 ⇒ onError 留痕、其余照删、不抛出
  mk('2026-08-01');
  const errs: string[] = [];
  const failing = new MediaStore(join(dir, 'uploads'), {
    onError: (e, what) => errs.push(`${what}:${e.message}`),
    removeDir: (p) => { if (p.endsWith('2026-08-01')) throw new Error('EACCES(mock)'); rmSync(p, { recursive: true, force: true }); },
  });
  expect(failing.prune(now)).toEqual([]);                                               // 2026-08-01 失败不进 removed
  expect(errs.length).toBe(1);
  expect(errs[0]).toContain('2026-08-01');
  expect(existsSync(join(dir, 'uploads', '2026-08-01'))).toBe(true);                    // 失败目录仍在
  expect(store.prune(now)).toEqual(['2026-08-01']);                                     // 默认 removeDir 重试成功
});

test('prune：uploads 目录缺失（ENOENT）⇒ 静默空结果；读目录 IO 错误 ⇒ onError 留痕不抛', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-media2-'));                                // 无 uploads/
  expect(new MediaStore(join(dir, 'uploads')).prune()).toEqual([]);                     // ENOENT 静默（启动安全）
  const errs: string[] = [];
  const ioErr = new MediaStore(join(dir, 'uploads'), {
    onError: (e, what) => errs.push(`${what}:${e.message}`),
    readdir: () => { throw Object.assign(new Error('EACCES(mock)'), { code: 'EACCES' }); },
  });
  expect(ioErr.prune()).toEqual([]);                                                    // 不抛
  expect(errs.length).toBe(1);                                                          // 但留痕（非 ENOENT 不吞）
});

test('attachmentNote：image/file 带绝对路径 + Read 提示；voice/video 归档 + 不可解析声明；恒单行', () => {
  const img = attachmentNote('image', '/ws/.bot/uploads/2026-09-13/m1-photo.jpg', 1024);
  expect(img).toContain('/ws/.bot/uploads/2026-09-13/m1-photo.jpg');
  expect(img).toContain('Read');
  expect(img).not.toContain('\n');
  const voice = attachmentNote('voice', '/ws/.bot/uploads/2026-09-13/m1-voice.amr', 2048);
  expect(voice).toContain('已归档');
  expect(voice).toContain('无法解析');
  expect(voice).toContain('amr');
  expect(attachmentNote('video', '/p.mp4', 1)).toContain('无法解析');
  expect(attachmentNote('file', '/p.pdf', 1)).toContain('Read');
});

test('degradedNote：三降级原因渲染，恒单行', () => {
  expect(degradedNote('image', 'empty')).toContain('未能成功接收');
  expect(degradedNote('file', 'oversize')).toContain('100MB');
  expect(degradedNote('voice', 'save-failed')).toContain('未能成功接收');
  expect(MAX_MEDIA_BYTES).toBe(100 * 1024 * 1024);
});
```

- [ ] **Step 2: Run it and verify it FAILS** — Run: `bun test tests/unit/media.test.ts` Expected: FAIL（`Cannot find module '../../src/media'`）
- [ ] **Step 3: Write the minimal implementation**（`src/media.ts`）

```ts
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type MediaKind = 'image' | 'file' | 'voice' | 'video';

/** D8 防御帽：平台本就限 100 MB 入站——SDK 全量缓冲后判定的双保险（内存尖峰见 plan Risk Notes） */
export const MAX_MEDIA_BYTES = 100 * 1024 * 1024;

const FALLBACK_EXT: Record<MediaKind, string> = { image: 'jpg', file: 'bin', voice: 'amr', video: 'mp4' };
const NAME_BUDGET_BYTES = 120;
const RETENTION_DAYS = 30;
const PRUNE_INTERVAL_MS = 24 * 60 * 60_000;
const DATE_DIR_RE = /^\d{4}-\d{2}-\d{2}$/;

const KIND_LABEL: Record<MediaKind, string> = { image: '图片', file: '文件', voice: '语音', video: '视频' };

const MSGID_MAX = 64;

/** msgid 是平台输入（不可信）：字符集白名单 + 长度帽——直入文件路径/prompt 前会穿越/注入。
 *  空串产出占位 `_`（不产生空前缀）。 */
export function safeMsgid(msgid: string): string {
  const safe = msgid.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, MSGID_MAX);
  return safe || '_';
}

/** D6 落盘名：`<safeMsgid>-<base>.<ext>`——剥路径分隔符/控制字符/换行（prompt 注入防线）、空白折叠、
 *  扩展保留后按 UTF-8 字节截断；缺名/消毒后空 ⇒ fallback `<safeMsgid>-<kind>.<默认 ext>`。
 *  safeMsgid 前缀保碰撞安全与重投递幂等。 */
export function sanitizeName(msgid: string, rawFilename: string | undefined, kind: MediaKind): string {
  const prefix = `${safeMsgid(msgid)}-`;
  if (!rawFilename) return `${prefix}${kind}.${FALLBACK_EXT[kind]}`;
  let name = rawFilename.replace(/[\\/]/g, '').replace(/[\x00-\x1f\x7f]+/g, '').replace(/\s+/g, ' ').trim();
  if (!name) return `${prefix}${kind}.${FALLBACK_EXT[kind]}`;
  let ext = FALLBACK_EXT[kind];
  const m = name.match(/\.([A-Za-z0-9]{1,8})$/);
  if (m) {
    ext = m[1]!;
    name = name.slice(0, name.length - m[1]!.length - 1);
  }
  name = name.replace(/^\.+/, '').replace(/\.+$/, '').trim() || kind;
  while (name && Buffer.byteLength(`${prefix}${name}.${ext}`, 'utf8') > NAME_BUDGET_BYTES) name = name.slice(0, -1);
  return `${prefix}${name}.${ext}`;
}

/** D7：附件 note——image/file 携绝对路径 + Read 提示；voice/video 归档 + 显式不可解析声明。 */
export function attachmentNote(kind: MediaKind, absPath: string, bytes: number): string {
  if (kind === 'voice' || kind === 'video') {
    const fmt = kind === 'voice' ? 'amr 音频' : 'mp4 视频';
    return `[附件] 用户发送的${KIND_LABEL[kind]}（${fmt}）已归档到本地：${absPath}（${bytes} 字节）。注意：${KIND_LABEL[kind]}内容在当前版本无法解析（未做转写）——请据此回应用户（如请用户以文字复述）。`;
  }
  return `[附件] 用户发送的${KIND_LABEL[kind]}已保存到本地：${absPath}（${bytes} 字节）。请使用 Read 工具查看该${KIND_LABEL[kind]}后再回应用户。`;
}

/** D8 降级 note：附件未落盘（空/超帽/落盘失败）——回合照跑，绝不静默丢。 */
export function degradedNote(kind: MediaKind, reason: 'empty' | 'oversize' | 'save-failed'): string {
  const r = reason === 'empty' ? '内容为空' : reason === 'oversize' ? '超出 100MB 上限' : '保存失败';
  return `[附件] 用户发送的${KIND_LABEL[kind]}未能成功接收（${r}），内容不可用。请告知用户附件未能接收，请其重新发送。`;
}

export class MediaStore {
  private pruneTimer: NodeJS.Timeout | null = null;

  constructor(
    private uploadsDir: string,
    private opts: { now?: () => Date; onError?: (err: Error, what: string) => void; removeDir?: (dir: string) => void; readdir?: (dir: string) => string[] } = {},
  ) {}

  /** D6：本地时区日期目录 + 消毒名落盘；同 msgid 重投递幂等覆盖。 */
  save(kind: MediaKind, msgid: string, buffer: Buffer, filename?: string): { absPath: string; bytes: number } {
    const dateDir = this.dateDirOf(this.now());
    mkdirSync(join(this.uploadsDir, dateDir), { recursive: true });
    const absPath = join(this.uploadsDir, dateDir, sanitizeName(msgid, filename, kind));
    writeFileSync(absPath, buffer);
    return { absPath, bytes: buffer.length };
  }

  /** D9：删除严格早于（当日 − 30 天）当日零点的日期目录；逐目录 try/catch（失败 onError 不抛）；
   *  非日期条目不动。边界语义：恰 30 天前的当日目录保留（30 天保留期 = ≥30 天可用）。
   *  removeDir/readdir 可注入（测试失败面的确定性覆盖——chmod 法在 root 下不失效不可靠）。
   *  读目录失败仅 ENOENT 静默（脚手架未建安全）；EACCES 等 IO 错误 onError 留痕不抛。 */
  prune(now?: Date): string[] {
    const n = now ?? this.now();
    const cutoff = new Date(n.getFullYear(), n.getMonth(), n.getDate() - RETENTION_DAYS);
    const removeDir = this.opts.removeDir ?? ((p: string) => rmSync(p, { recursive: true, force: true }));
    const readdir = this.opts.readdir ?? ((p: string) => readdirSync(p));
    let entries: string[];
    try {
      entries = readdir(this.uploadsDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []; // 目录缺失——启动安全
      this.opts.onError?.(err as Error, 'prune readdir');
      return [];
    }
    const removed: string[] = [];
    for (const e of entries) {
      if (!DATE_DIR_RE.test(e)) continue;
      const [y, mo, d] = e.split('-').map(Number) as [number, number, number];
      const dirDate = new Date(y!, mo! - 1, d!);
      if (Number.isNaN(dirDate.getTime()) || dirDate >= cutoff) continue;
      try {
        removeDir(join(this.uploadsDir, e));
        removed.push(e);
      } catch (err) {
        this.opts.onError?.(err as Error, `prune ${e}`);
      }
    }
    return removed;
  }

  /** D9：每 24 h 定时剪枝（unref——不阻退出）；启动即剪由 wiring 显式调用 prune()。 */
  startPruneTimer(): void {
    if (this.pruneTimer) return;
    this.pruneTimer = setInterval(() => {
      try {
        this.prune();
      } catch (err) {
        this.opts.onError?.(err as Error, 'prune timer');
      }
    }, PRUNE_INTERVAL_MS);
    this.pruneTimer.unref();
  }

  private now(): Date { return this.opts.now ? this.opts.now() : new Date(); }

  private dateDirOf(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
}
```

- [ ] **Step 4: Run it and verify it PASSES** — Run: `bun test tests/unit/media.test.ts` Expected: PASS（7 tests）
- [ ] **Step 5: Commit** — `git add src/media.ts tests/unit/media.test.ts && git commit -m "W4: MediaStore — sanitize (traversal/control-char/newline strip, ext-preserving truncation), date-dir layout, 30d prune, attachment notes"`

### Task 2: transport 事件面 + downloadFile 端口 + mock/桩迁移

**Files:**
- Modify: `src/transport/types.ts`（`MediaKind` re-export、`InboundMediaMessage`、事件联合、接口增员）
- Modify: `src/transport/wecom-sdk-adapter.ts`（四媒体事件订阅 + `downloadFile` 委托）
- Modify: `tests/helpers/mock-wecom-server.ts`（`pushMediaMessage`）
- Modify: `tests/unit/agent-handler.test.ts`（**同 commit 迁移 FakeTransport**——接口扩员即时补桩，W3 R2-F2 教训）
- Test: `tests/integration/transport.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1 `MediaKind`
- Produces:
  - `src/transport/types.ts`: `export interface InboundMediaMessage { msgid: string; chatType: 'single' | 'group'; chatId?: string; userId: string; kind: MediaKind; url?: string; aeskey?: string; replyTo: ReplyRef }`（**url 可选**——缺 url 的协议异常帧仍上抛事件，由 handler 走 D8 错误面，不在 adapter 静默丢）；`TransportEvent` 增 `| { type: 'mediaMessage'; message: InboundMediaMessage }`；`WeComTransport` 增 `downloadFile(url: string, aeskey?: string): Promise<{ buffer: Buffer; filename?: string }>`（D2——SDK 委托，throw 原样上抛）
  - Mock: `pushMediaMessage(reqId, msg: { msgid; userId; kind: MediaKind; url?; aeskey?; chatType?; chatid? })`
  - FakeTransport 桩：`downloads: Array<{ url: string; aeskey?: string }>` + `downloadImpl: (url, aeskey?) => Promise<{buffer, filename?}>`

- [ ] **Step 1: Write the failing test**（追加进 `tests/integration/transport.test.ts`，沿用既有 transport 装配模式；import 区补 `import type { InboundMediaMessage } from '../../src/transport/types';`）

```ts
test('W4：四类媒体帧映射 mediaMessage 事件；群媒体忽略；缺 url 帧仍上抛（不静默丢）；downloadFile 端口守卫', async () => {
  const srv = new MockWecomServer();
  const { url } = await srv.start();
  const t = new WecomSdkTransport({ botId: 'b', secret: 's', wsUrl: url, ...FAST });
  const rec = recorder();
  t.on(rec.push);
  await t.start();
  for (const [i, kind] of ['image', 'file', 'voice', 'video'].entries()) {
    srv.pushMediaMessage(`req-m${i}`, { msgid: `m${i}`, userId: 'u1', kind: kind as 'image', url: 'https://files.example/x', aeskey: 'a2V5' });
  }
  srv.pushMediaMessage('req-g1', { msgid: 'g1', userId: 'u1', kind: 'image', url: 'https://files.example/x', chatType: 'group', chatid: 'g1' });
  srv.pushMediaMessage('req-n1', { msgid: 'n1', userId: 'u1', kind: 'voice' });           // 缺 url（voice .d.ts 形状）——仍上抛
  await new Promise((r) => setTimeout(r, 300));
  const media = rec.events.filter((e) => e.type === 'mediaMessage') as Array<{ type: 'mediaMessage'; message: InboundMediaMessage }>;
  expect(media.length).toBe(5);                                            // 群媒体帧被 adapter 忽略（D10）；缺 url 帧不丢
  expect(media.slice(0, 4).map((e) => e.message.kind)).toEqual(['image', 'file', 'voice', 'video']);
  expect(media[0]!.message.userId).toBe('u1');
  expect(media[0]!.message.url).toBe('https://files.example/x');
  expect(media[0]!.message.aeskey).toBe('a2V5');
  expect(media[0]!.message.replyTo.reqId).toBe('req-m0');
  const noUrl = media[4]!.message;
  expect(noUrl.kind).toBe('voice');
  expect(noUrl.url).toBeUndefined();                                       // handler 侧走 D8 错误面
  await t.stop();
  await expect(t.downloadFile('https://files.example/x', 'a2V5')).rejects.toThrow('transport not started'); // 端口存在 + 未启动守卫（真下载由 media.test.ts 集成覆盖——不在单测打真网络）
  await srv.stop();
});
```

- [ ] **Step 2: Run it and verify it FAILS** — Run: `bun test tests/integration/transport.test.ts` Expected: FAIL（`pushMediaMessage` 不是函数 / `mediaMessage` 类型不存在——typecheck 亦红）
- [ ] **Step 3: Write the minimal implementation**

`src/transport/types.ts`——import 区补 `import type { MediaKind } from '../media'; export type { MediaKind };`（类型单向依赖：transport ← media），`InboundFeedbackEvent` 之后追加：

```ts
/** W4 入站媒体（单聊 image/file/voice/video——平台契约；url 5 分钟有效，per-link aeskey）。
 *  url/aeskey 均可选：缺失 = 协议异常帧（voice .d.ts 只声明 content 等）——仍上抛事件，
 *  由 handler 走 D8 错误面（never silent drop）；adapter 不得静默丢。 */
export interface InboundMediaMessage {
  msgid: string;
  chatType: 'single' | 'group';
  chatId?: string;
  userId: string;
  kind: MediaKind;
  url?: string;
  aeskey?: string;
  replyTo: ReplyRef;
}
```

`TransportEvent` 联合追加 `| { type: 'mediaMessage'; message: InboundMediaMessage }`；`WeComTransport` 接口追加：

```ts
  /** W4：SDK 内建下载+解密端口（Q12——无自研 crypto）；过期 URL/解密失败原样 throw（D8 错误面） */
  downloadFile(url: string, aeskey?: string): Promise<{ buffer: Buffer; filename?: string }>;
```

`src/transport/wecom-sdk-adapter.ts`——`message.text` 订阅块之后追加（复用 `refFromFrame`）：

```ts
      // W4：四类媒体统一映射（D1）；群媒体 debug 忽略（平台 single-chat only——D10 fail-safe）。
      // 缺 url 的协议异常帧仍上抛（url 可选）——静默丢违反 never-silent-drop（D8 由 handler 收口错误面）。
      const MEDIA_KINDS = ['image', 'file', 'voice', 'video'] as const;
      for (const kind of MEDIA_KINDS) {
        client.on(`message.${kind}`, (frame: WsFrame) => {
          const body = frame.body as unknown as {
            msgid: string; chattype?: 'single' | 'group'; chatid?: string;
            from: { userid: string };
          } & Record<string, unknown>;
          if ((body.chattype ?? 'single') === 'group') {
            this.opts.logger?.debug?.(`group media (${kind}) ignored: ${body.msgid}`);
            return;
          }
          const content = body[kind] as { url?: string; aeskey?: string } | undefined;
          if (!content?.url) {
            this.opts.logger?.debug?.(`media frame without url forwarded (protocol anomaly): ${body.msgid}`);
          }
          this.emit({
            type: 'mediaMessage',
            message: {
              msgid: body.msgid,
              chatType: 'single',
              userId: body.from?.userid ?? 'unknown',
              kind,
              ...(content?.url ? { url: content.url } : {}),
              ...(content?.aeskey ? { aeskey: content.aeskey } : {}),
              replyTo: refFromFrame(frame),
            },
          });
        });
      }
```

类方法区（`replyWelcome` 之后）追加：

```ts
  async downloadFile(url: string, aeskey?: string): Promise<{ buffer: Buffer; filename?: string }> {
    if (!this.client) throw new Error('transport not started');
    return this.client.downloadFile(url, aeskey); // SDK 内建下载+解密（Q12）
  }
```

`tests/helpers/mock-wecom-server.ts`——`pushFeedbackEvent` 之后追加：

```ts
  /** W4：媒体帧（msgtype=kind，载荷 {url?, aeskey?}——均可省略以模拟协议异常帧；voice 的 url/aeskey 平台协议字段——.d.ts 未声明，运行时防御式读取同真实平台） */
  pushMediaMessage(reqId: string, msg: { msgid: string; userId: string; kind: 'image' | 'file' | 'voice' | 'video'; url?: string; aeskey?: string; chatType?: 'single' | 'group'; chatid?: string }): void {
    this.broadcast({
      cmd: 'aibot_msg_callback',
      headers: { req_id: reqId },
      body: {
        msgid: msg.msgid, aibotid: 'bot-mock', chattype: msg.chatType ?? 'single',
        ...(msg.chatType === 'group' && msg.chatid ? { chatid: msg.chatid } : {}),
        from: { userid: msg.userId }, msgtype: msg.kind,
        [msg.kind]: { ...(msg.url ? { url: msg.url } : {}), ...(msg.aeskey ? { aeskey: msg.aeskey } : {}) },
        create_time: Math.floor(Date.now() / 1000),
      },
    });
  }
```

`tests/unit/agent-handler.test.ts` 的 FakeTransport **同 commit** 补桩：

```ts
// FakeTransport 追加：
  downloads: Array<{ url: string; aeskey?: string }> = [];
  downloadImpl: (url: string, aeskey?: string) => Promise<{ buffer: Buffer; filename?: string }> =
    async () => ({ buffer: Buffer.alloc(0) });
  async downloadFile(url: string, aeskey?: string) { this.downloads.push({ url, aeskey }); return this.downloadImpl(url, aeskey); }
```

- [ ] **Step 4: Run it and verify it PASSES** — Run: `bun test tests/integration/transport.test.ts tests/unit/agent-handler.test.ts && bun run typecheck` Expected: PASS（fake 迁移后既有用例不回归）
- [ ] **Step 5: Commit** — `git add src/transport/types.ts src/transport/wecom-sdk-adapter.ts tests/helpers/mock-wecom-server.ts tests/unit/agent-handler.test.ts tests/integration/transport.test.ts && git commit -m "W4: transport mediaMessage event (unified kind union), SDK downloadFile port, mock pushMediaMessage + fake migration"`

## Checkpoint A（Tasks 1–2 后）

- [ ] `bun run typecheck` 通过
- [ ] **SDK pin 核验**（加密镜像与 SDK `decryptFile` 内部耦合）：`grep '"@wecom/aibot-node-sdk"' package.json` 输出必须精确 `"@wecom/aibot-node-sdk": "1.0.7"`（无 `^`/`~`）；`bun pm ls | grep aibot` 确认解析版本 1.0.7——不匹配即停（Task 4 加密镜像会以错误方式漂移）
- [ ] `bun test tests/unit/media.test.ts tests/integration/transport.test.ts tests/unit/agent-handler.test.ts` 全绿
- [ ] `bun test`（全量）不回归

### Task 3: AgentHandler.onMedia 编排 + createGateway 接线

**Files:**
- Modify: `src/handlers/agent.ts`（import 区、deps 增 `media`、register 分流、`onMedia` 私有方法）
- Modify: `src/gateway.ts`（createGateway 装配 MediaStore + 启动剪枝——**同 commit**，W3 R3-F2 教训）
- Test: `tests/unit/agent-handler.test.ts`（追加媒体流用例；`makeHandler`/`makeGatedHandler` fixture 同 commit 增 MediaStore 装配）

**Interfaces:**
- Consumes: Task 1 `MediaStore`/`attachmentNote`/`degradedNote`/`MAX_MEDIA_BYTES`；Task 2 `InboundMediaMessage`/`downloadFile` 端口；既有 `chatKeyOf`/`buildContextPreamble`/`expireStaleAsk`/`criticalFinal`/`notice`/`REJECTION_TEXT`
- Produces:
  - handler deps 增 `media: MediaStore`
  - `AgentHandler.onMedia(m: InboundMediaMessage): Promise<void>`（私有——编排序即 Global Constraints 分派序）

- [ ] **Step 1: Write the failing test**（追加进 `tests/unit/agent-handler.test.ts`；import 区补 `import { MediaStore } from '../../src/media';`、`import type { InboundMediaMessage } from '../../src/transport/types';`）

fixture 增装配（两个 fixture 同 commit 改）：

```ts
// makeHandler / makeGatedHandler 内，AgentHandler 构造前追加：
  const media = new MediaStore(join(dir, 'uploads'));
  // AgentHandler deps 增 media（makeGatedHandler 返回值追加 media 供断言）
```

```ts
const MEDIA = (over: Partial<InboundMediaMessage> = {}): { type: 'mediaMessage'; message: InboundMediaMessage } => ({
  type: 'mediaMessage',
  message: { msgid: 'mm1', chatType: 'single', userId: 'u1', kind: 'image', url: 'https://f/x.jpg', aeskey: 'k1', replyTo: { __brand: 'ReplyRef', reqId: 'rm1' }, ...over },
});

test('W4 AC1/AC2 桥：image/file 下载落盘 → submit prompt 携带 [Context] 前导 + 绝对路径 note', async () => {
  const { handler, transport, manager, dir } = makeHandler();
  handler.register();
  transport.downloadImpl = async () => ({ buffer: Buffer.from('jpegbytes'), filename: 'photo.jpg' });
  transport.emit(MEDIA());
  await flush();
  expect(transport.downloads).toEqual([{ url: 'https://f/x.jpg', aeskey: 'k1' }]);
  expect(manager.submitted.length).toBe(1);
  const prompt = manager.submitted[0]!.prompt;
  expect(prompt.startsWith('[Context: sender=u1, userid=u1, chat=u1 (p2p)]\n\n')).toBe(true);
  expect(prompt).toContain('Read');
  expect(prompt).toContain(join(dir, 'uploads'));       // 绝对路径入 note
  expect(prompt).toContain('mm1-photo.jpg');            // msgid 前缀消毒名
  expect(prompt).toContain('9 字节');                    // 字节数
  const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
  expect(existsSync(join(dir, 'uploads', today, 'mm1-photo.jpg'))).toBe(true);          // 落盘（深断言在 media.test.ts）
});

test('W4 AC3 桥：voice/video 下载归档 → note 含「无法解析」；不携带 Read 指令', async () => {
  const { handler, transport, manager } = makeHandler();
  handler.register();
  transport.downloadImpl = async () => ({ buffer: Buffer.alloc(32) });
  transport.emit(MEDIA({ kind: 'voice', msgid: 'v1' }));
  await flush();
  const p1 = manager.submitted[0]!.prompt;
  expect(p1).toContain('无法解析');
  expect(p1).toContain('amr');
  expect(p1).not.toContain('Read 工具查看');
  transport.emit(MEDIA({ kind: 'video', msgid: 'v2' }));
  await flush();
  expect(manager.submitted[1]!.prompt).toContain('无法解析');
});

test('W4 AC4 桥：下载 throw ⇒ criticalFinal 短错误（不 submit、不下载两次）；错误文案含「重新发送」', async () => {
  const { handler, transport, manager } = makeHandler();
  handler.register();
  transport.downloadImpl = async () => { throw new Error('decryptFile: Decryption failed'); };
  transport.emit(MEDIA());
  await flush();
  expect(manager.submitted.length).toBe(0);
  const last = transport.sent.at(-1)!;
  expect(last.finish).toBe(true);
  expect(last.content).toContain('附件接收失败');
  expect(last.content).toContain('重新发送');
});

test('W4 降级：空 buffer / 超帽 buffer ⇒ 不落盘、submit prompt 携带降级 note、回合照跑', async () => {
  const { handler, transport, manager } = makeHandler();
  handler.register();
  transport.downloadImpl = async () => ({ buffer: Buffer.alloc(0), filename: 'x.jpg' });
  transport.emit(MEDIA({ msgid: 'e1' }));
  await flush();
  expect(manager.submitted[0]!.prompt).toContain('未能成功接收');
  transport.downloadImpl = async () => ({ buffer: Buffer.alloc(MAX_MEDIA_BYTES + 1), filename: 'big.bin' });
  transport.emit(MEDIA({ msgid: 'o1', kind: 'file' }));
  await flush();
  expect(manager.submitted[1]!.prompt).toContain('100MB');
});

test('W4 协议异常：缺 url / 缺 aeskey ⇒ 与下载失败同面（关键终帧错误、零下载、零 submit）', async () => {
  const { handler, transport, manager } = makeHandler();
  handler.register();
  transport.emit(MEDIA({ msgid: 'nu1', url: undefined }));                    // 缺 url（voice .d.ts 形状）
  await flush();
  expect(transport.downloads.length).toBe(0);
  expect(manager.submitted.length).toBe(0);
  expect(transport.sent.at(-1)!.finish).toBe(true);
  expect(transport.sent.at(-1)!.content).toContain('附件接收失败');
  transport.emit(MEDIA({ msgid: 'nk1', aeskey: undefined }));                 // 缺 aeskey——密文不得当附件
  await flush();
  expect(transport.downloads.length).toBe(0);                                 // 未尝试下载（无 key 密文无意义）
  expect(manager.submitted.length).toBe(0);
  expect(transport.sent.at(-1)!.content).toContain('附件接收失败');
});

test('W4 落盘失败 ⇒ 降级 note、回合照跑、仅一次下载（确定性：目标路径预置为目录）', async () => {
  const { handler, transport, manager, dir } = makeHandler();
  handler.register();
  const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
  mkdirSync(join(dir, 'uploads', today, 'sv1-photo.jpg'), { recursive: true });  // writeFileSync 目标是目录 ⇒ EISDIR
  transport.downloadImpl = async () => ({ buffer: Buffer.from('x'), filename: 'photo.jpg' });
  transport.emit(MEDIA({ msgid: 'sv1' }));
  await flush();
  expect(transport.downloads.length).toBe(1);                                // 不重试下载
  expect(manager.submitted.length).toBe(1);
  expect(manager.submitted[0]!.prompt).toContain('未能成功接收');              // save-failed 降级 note
});

test('W4 gate：未授权/陌生人媒体 ⇒ 拒绝文案 + 零下载 + 零 submit；群媒体帧忽略', async () => {
  const { handler, transport, manager } = makeGatedHandler({ approved: ['u1'] });
  handler.register();
  transport.emit(MEDIA({ userId: 'stranger' }));
  await flush();
  expect(transport.sent.at(-1)!.content).toContain('未被授权');
  expect(transport.downloads.length).toBe(0);           // 先拒绝后下载（D4）
  expect(manager.submitted.length).toBe(0);
  transport.emit(MEDIA({ chatType: 'group', chatId: 'g1' }));
  await flush();
  expect(transport.downloads.length).toBe(0);           // 群媒体 handler 防御性忽略
  expect(transport.sent.length).toBe(1);                // 无新增回执
});

test('W4 pending-ask：媒体不认领 ask（无 answerPendingAsk 调用）、照常 submit 排队', async () => {
  const { handler, transport, manager } = makeHandler();
  handler.register();
  manager.pendingFlag = true;
  transport.downloadImpl = async () => ({ buffer: Buffer.from('x'), filename: 'a.png' });
  transport.emit(MEDIA());
  await flush();
  expect(manager.answers.length).toBe(0);               // 未作答
  expect(manager.submitted.length).toBe(1);             // 照常进回合（busy 时由 manager 排队）
});

test('W4 queue-full：submit 拒收 ⇒ 队列满提示', async () => {
  const manager = new FakeManager();
  manager.submitResult = 'queue-full';
  const { handler, transport } = makeHandler(manager);
  handler.register();
  transport.downloadImpl = async () => ({ buffer: Buffer.from('x'), filename: 'a.png' });
  transport.emit(MEDIA());
  await flush();
  expect(transport.sent.at(-1)!.content).toContain('队列已满');
});
```

（import 区补 `existsSync`——`node:fs` 既有 import 追加；`MAX_MEDIA_BYTES` 自 `../../src/media` 追加 import。）

- [ ] **Step 2: Run it and verify it FAILS** — Run: `bun test tests/unit/agent-handler.test.ts` Expected: FAIL（AgentHandler deps 无 media——构造类型错/typecheck 红）
- [ ] **Step 3: Write the minimal implementation**

`src/handlers/agent.ts`——import 区追加：

```ts
import type { InboundMediaMessage } from '../transport/types';
import { MediaStore, attachmentNote, degradedNote, MAX_MEDIA_BYTES } from '../media';
```

deps 类型追加 `media: MediaStore`。

`register()` 分流（`feedbackEvent` 分支之后、`if (event.type !== 'textMessage') return;` 之前插入）：

```ts
      if (event.type === 'mediaMessage') {
        // C4 同构：入站媒体处理的意外失败必须可见 + 用户必有回声（criticalFinal 兜底）
        this.onMedia(event.message).catch((e: unknown) => {
          this.deps.logger.error('media handling failed', { msgid: event.message.msgid, err: (e as Error).message });
          this.opts.onReplyError?.(e as Error);
          if (event.message.chatType !== 'group') {
            void this.criticalFinal(event.message.replyTo, chatKeyOf(event.message), '⚠️ 处理失败，请稍后重试。')
              .catch(() => { /* 兜底帧失败已由 rawSend 留痕 */ });
          }
        });
        return;
      }
```

`onText` 之后新增私有方法：

```ts
  /** W4 媒体编排（D4/D5/D8）：群守卫 → gate（未授权零下载）→ 过期 ask → 下载（5 分钟窗内立即）→
   *  落盘 → note → submit。媒体绝不喂 answerPendingAsk（不可能是数字/文字作答；pending 不因媒体失效）。 */
  private async onMedia(m: InboundMediaMessage): Promise<void> {
    if (m.chatType === 'group') {
      this.deps.logger.debug('group media ignored (platform single-chat only)', { msgid: m.msgid });
      return;
    }
    const chatKey = chatKeyOf(m);
    const snap = this.deps.access.load();
    const tier = snap.tierOf(m.userId);
    if (tier !== 'admin' && tier !== 'approved') {
      this.deps.logger.info('p2p media sender not authorized', { msgid: m.msgid, userId: m.userId });
      await this.notice(m.replyTo, chatKey, REJECTION_TEXT);
      return;
    }
    if (this.deps.manager.expireStaleAsk(chatKey)) {
      const st = this.ensureStream(m.replyTo, chatKey);
      st.banner = `${st.banner}⚠️ 上一个问题已超时失效，已开启新会话\n\n`;
      st.ref = m.replyTo;
    }
    // D8 协议异常面：长连接模式媒体恒加密——缺 aeskey 的密文不得当可解析附件落盘（SDK 无 key 原样返回密文）；
    // 缺 url 无法下载。两者与下载失败同面（AC4 关键终帧短错误），零下载、不 spawn。
    if (!m.url || !m.aeskey) {
      this.deps.logger.error('media frame missing url/aeskey', { msgid: m.msgid, kind: m.kind, hasUrl: !!m.url, hasAeskey: !!m.aeskey });
      await this.criticalFinal(m.replyTo, chatKey, '⚠️ 附件接收失败（下载超时或解密失败），请重新发送。');
      return;
    }
    let downloaded: { buffer: Buffer; filename?: string };
    try {
      downloaded = await this.deps.transport.downloadFile(m.url, m.aeskey); // D5：过 gate 即下载——排队不得吞噬 5 分钟窗
    } catch (e) {
      // D8：下载/解密失败 ⇒ 关键终帧短错误（AC4 硬保证——不走可丢弃 notice），不 spawn
      this.deps.logger.error('media download failed', { msgid: m.msgid, kind: m.kind, err: (e as Error).message });
      await this.criticalFinal(m.replyTo, chatKey, '⚠️ 附件接收失败（下载超时或解密失败），请重新发送。');
      return;
    }
    let note: string;
    if (downloaded.buffer.length === 0 || downloaded.buffer.length > MAX_MEDIA_BYTES) {
      const reason = downloaded.buffer.length === 0 ? 'empty' : 'oversize';
      this.deps.logger.warn('media degraded', { msgid: m.msgid, kind: m.kind, bytes: downloaded.buffer.length, reason });
      note = degradedNote(m.kind, reason);
    } else {
      try {
        const saved = this.deps.media.save(m.kind, m.msgid, downloaded.buffer, downloaded.filename);
        this.deps.logger.info('media saved', { msgid: m.msgid, kind: m.kind, path: saved.absPath, bytes: saved.bytes });
        note = attachmentNote(m.kind, saved.absPath, saved.bytes);
      } catch (e) {
        // D8：落盘失败 ⇒ 降级 note（回合照跑，绝不静默丢）
        this.deps.logger.error('media save failed', { msgid: m.msgid, kind: m.kind, err: (e as Error).message });
        note = degradedNote(m.kind, 'save-failed');
      }
    }
    const prompt = buildContextPreamble({ userId: m.userId, chatKey, chatType: m.chatType }) + note;
    const verdict = this.deps.manager.submit(chatKey, m.chatType, m.userId, prompt, (ev) => this.bridge(m.replyTo, chatKey, ev));
    if (verdict === 'queue-full') {
      await this.notice(m.replyTo, chatKey, '消息队列已满，请稍后再试。');
    }
  }
```

`src/gateway.ts` createGateway——AccessGate 构造之后追加（**与 handler 改动同 commit**）：

```ts
  const media = new MediaStore(join(ws.botDir, 'uploads'), {
    onError: (e, what) => logger.warn('uploads prune failed', { what, err: e.message }),
  });
  media.prune();            // D9：启动即剪
  media.startPruneTimer();  // 24 h unref 定时
```

（import 区补 `import { MediaStore } from './media';`；AgentHandler 构造 deps 增 `media`。）

- [ ] **Step 4: Run it and verify it PASSES（全量门）** — Run: `bun run typecheck && bun test` Expected: PASS（媒体新用例 + W1–W3 全部回归绿）
- [ ] **Step 5: Commit** — `git add src/handlers/agent.ts src/gateway.ts tests/unit/agent-handler.test.ts && git commit -m "W4: AgentHandler media orchestration (gate-before-download, critical-final error path, degrade notes) + gateway MediaStore wiring"`

## Checkpoint B（Task 3 后）

- [ ] `bun run typecheck && bun test` 全绿
- [ ] 媒体失败面全部路径各有单测锚定：下载 throw / 缺 url / 缺 aeskey（错误面）；空 / 超帽 / 落盘失败（降级面）
- [ ] `git check-ignore .bot/uploads` 命中（`.gitignore` 的 `.bot/` 行——附件不入库复核）

### Task 4: 端到端集成 — AC1–AC4（真 SDK 下载解密）

**Files:**
- Create: `tests/helpers/media-file-server.ts`（本地 HTTP 文件服务端 + 测试侧 AES 加密镜像）
- Test: `tests/integration/media.test.ts`（新建）

**Interfaces:**
- Consumes: Tasks 1–3 完整装配（mock WeCom WS + fake claude + createGateway）
- Produces:
  - `export function encryptMedia(plain: Buffer, aesKeyB64: string): Buffer`（AES-256-CBC、IV=key[:16]、PKCS#7 填充至 32 字节块——SDK `decryptFile` 的互逆镜像；**仅测试用**，Q12 约束的是产品路径）
  - `export class MediaFileServer { add(pathname, data, opts?: { filename?; status? }); start(): Promise<{ port; base }>; stop(): Promise<void> }`

- [ ] **Step 1: Write the helper and failing tests**（`tests/helpers/media-file-server.ts`）

```ts
import { createServer, type Server } from 'node:http';
import { createCipheriv } from 'node:crypto';

/** SDK decryptFile 的互逆镜像（AES-256-CBC、IV=key 前 16 字节、PKCS#7 填充至 32 字节块）。
 *  测试侧加密——Q12 禁的是产品路径自研 crypto；SDK 版本已 pin 1.0.7（package.json）。 */
export function encryptMedia(plain: Buffer, aesKeyB64: string): Buffer {
  const key = Buffer.from(aesKeyB64, 'base64');
  const padLen = 32 - (plain.length % 32); // padLen ∈ 1..32
  const padded = Buffer.concat([plain, Buffer.alloc(padLen, padLen)]);
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]);
}

export class MediaFileServer {
  private srv: Server | null = null;
  private files = new Map<string, { data: Buffer; filename?: string; status?: number }>();

  add(pathname: string, data: Buffer, opts: { filename?: string; status?: number } = {}): void {
    this.files.set(pathname, { data, ...opts });
  }

  async start(): Promise<{ port: number; base: string }> {
    this.srv = createServer((req, res) => {
      const f = this.files.get(req.url ?? '');
      if (!f) { res.writeHead(404); res.end(); return; }
      if (f.status !== undefined) { res.writeHead(f.status); res.end(); return; }
      // 非 ASCII 文件名走 RFC 5987（filename*=UTF-8''…）——SDK 解析器优先匹配 filename*；
      // 纯 ASCII 同时给 filename= 兜底（镜像真实平台行为）
      const disposition = f.filename
        ? (/[^\x20-\x7e]/.test(f.filename)
          ? `attachment; filename*=UTF-8''${encodeURIComponent(f.filename)}`
          : `attachment; filename="${f.filename}"`)
        : undefined;
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        ...(disposition ? { 'content-disposition': disposition } : {}),
      });
      res.end(f.data);
    });
    await new Promise<void>((r) => this.srv!.once('listening', r));
    const port = (this.srv!.address() as { port: number }).port;
    return { port, base: `http://127.0.0.1:${port}` };
  }

  async stop(): Promise<void> {
    const srv = this.srv;
    this.srv = null;
    if (!srv) return;
    await new Promise<void>((r) => {
      // bun 下 close() 握手竞态兜底（mock-wecom-server 同款）
      const timer = setTimeout(r, 1000);
      srv.close(() => { clearTimeout(timer); r(); });
      (srv as Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    });
  }
}
```

（`tests/integration/media.test.ts`）

```ts
import { test, expect, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createGateway } from '../../src/gateway';
import { MockWecomServer } from '../helpers/mock-wecom-server';
import { MediaFileServer, encryptMedia } from '../helpers/media-file-server';

const HELPER = join(import.meta.dir, '..', 'helpers', 'fake-claude.mjs');
const FAST = { reconnectInterval: 50, heartbeatInterval: 500, requestTimeout: 2000, resubscribeDelayMs: 150 };
// axios 默认读环境代理——本地文件服务端必须直连（CI 沙箱 HTTP_PROXY 防御）；保存原值，afterAll 还原
const prevNoProxy = process.env.NO_PROXY;
process.env.NO_PROXY = '127.0.0.1,localhost';
afterAll(() => { if (prevNoProxy === undefined) delete process.env.NO_PROXY; else process.env.NO_PROXY = prevNoProxy; });

async function waitUntil(cond: () => boolean, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitUntil timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function setupMedia(access: unknown = { approved: ['u1'] }) {
  const ws = mkdtempSync(join(tmpdir(), 'wb-media-e2e-'));
  const { loadWorkspace } = await import('../../src/config');
  loadWorkspace(ws);
  writeFileSync(join(ws, '.bot', '.env'), 'WECOM_BOT_ID=b\nWECOM_SECRET=s\n');
  writeFileSync(join(ws, '.bot', 'access.json'), JSON.stringify(access) + '\n');
  const stateDir = join(ws, 'fake-state');
  process.env.FAKE_CLAUDE_STATE_DIR = stateDir;
  process.env.FAKE_CLAUDE_SCENARIO = 'happy';
  const files = new MediaFileServer();
  const { base } = await files.start();
  const srv = new MockWecomServer();
  const { url } = await srv.start();
  const { gateway } = await createGateway(ws, { wsUrl: url, ...FAST }, {
    claudeCommand: { command: process.execPath, argsPrefix: [HELPER] }, refreshIntervalMs: 10,
  });
  await gateway.start();
  return { ws, srv, gateway, files, base, stateDir };
}

/** 断言失败不级联泄漏（gateway/WS/文件三服务端必停） */
async function withMedia(fn: (ctx: Awaited<ReturnType<typeof setupMedia>>) => Promise<void>): Promise<void> {
  const ctx = await setupMedia();
  try {
    await fn(ctx);
  } finally {
    await ctx.gateway.stop().catch(() => {});
    await ctx.srv.stop();
    await ctx.files.stop();
  }
}

interface StreamFrame { id: string; content: string; finish: boolean }
const streamsOf = (srv: MockWecomServer): StreamFrame[] =>
  srv.sentFrames.map((f) => (f.body as { stream?: StreamFrame }).stream!).filter(Boolean);
const todayDir = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

test('AC1：单聊图片——真 SDK 下载解密落盘 uploads/YYYY-MM-DD/；prompt 携带路径 note', async () => {
  await withMedia(async ({ srv, files, base, stateDir, ws }) => {
    const aeskey = randomBytes(32).toString('base64');
    const plain = Buffer.from('FAKE-JPEG-CONTENT-0123456789');
    files.add('/img.jpg', encryptMedia(plain, aeskey));                          // 无 filename ⇒ fallback 名
    srv.pushMediaMessage('rimg1', { msgid: 'img1', userId: 'u1', kind: 'image', url: `${base}/img.jpg`, aeskey });
    await waitUntil(() => streamsOf(srv).some((s) => s.finish));
    const dayDir = join(ws, '.bot', 'uploads', todayDir());
    const names = readdirSync(dayDir);
    expect(names.length).toBe(1);
    expect(names[0]).toBe('img1-image.jpg');                      // <safeMsgid>-<kind>.<ext> fallback（D6 统一形）
    expect(readFileSync(join(dayDir, names[0]!)).toString()).toBe(plain.toString()); // 解密后的明文（非密文）
    const stdin = readFileSync(join(stateDir, 'stdin.jsonl'), 'utf8');
    expect(stdin).toContain('[Context: sender=u1, userid=u1, chat=u1 (p2p)]');
    expect(stdin).toContain(join(dayDir, names[0]!));             // AC1：prompt 携带本地路径
    expect(stdin).toContain('Read');                              // note 指示 agent 读图
  });
});

test('AC2：文件同 AC1（RFC 5987 Content-Disposition 中文名保留）', async () => {
  await withMedia(async ({ srv, files, base, stateDir, ws }) => {
    const aeskey = randomBytes(32).toString('base64');
    const plain = Buffer.from('%PDF-1.4 fake pdf body');
    files.add('/doc.pdf', encryptMedia(plain, aeskey), { filename: '季度报告.pdf' });
    srv.pushMediaMessage('rfl1', { msgid: 'fl1', userId: 'u1', kind: 'file', url: `${base}/doc.pdf`, aeskey });
    await waitUntil(() => streamsOf(srv).some((s) => s.finish));
    const names = readdirSync(join(ws, '.bot', 'uploads', todayDir()));
    expect(names[0]).toBe('fl1-季度报告.pdf');
    const stdin = readFileSync(join(stateDir, 'stdin.jsonl'), 'utf8');
    expect(stdin).toContain('fl1-季度报告.pdf');
    expect(stdin).toContain('Read');
  });
});

test('AC3：语音/视频归档 + prompt 声明不可解析', async () => {
  await withMedia(async ({ srv, files, base, stateDir, ws }) => {
    const aeskey = randomBytes(32).toString('base64');
    files.add('/v.amr', encryptMedia(Buffer.from('AMR-AUDIO'), aeskey));
    files.add('/v.mp4', encryptMedia(Buffer.from('MP4-VIDEO'), aeskey));
    srv.pushMediaMessage('rvo1', { msgid: 'vo1', userId: 'u1', kind: 'voice', url: `${base}/v.amr`, aeskey });
    srv.pushMediaMessage('rvi1', { msgid: 'vi1', userId: 'u1', kind: 'video', url: `${base}/v.mp4`, aeskey });
    await waitUntil(() => streamsOf(srv).filter((s) => s.finish).length === 2);
    const names = readdirSync(join(ws, '.bot', 'uploads', todayDir())).sort();
    expect(names).toEqual(['vi1-video.mp4', 'vo1-voice.amr']);    // 归档落盘（fallback 名）
    const stdin = readFileSync(join(stateDir, 'stdin.jsonl'), 'utf8');
    expect(stdin).toContain('无法解析');
    expect(stdin).toContain('amr');
    expect(stdin).toContain('mp4');
  });
});

test('AC4：过期 URL（404）与 bad aeskey ⇒ 站内短错误、零 spawn、无文件落盘', async () => {
  await withMedia(async ({ srv, files, base, stateDir, ws }) => {
    const aeskey = randomBytes(32).toString('base64');
    files.add('/ok.bin', encryptMedia(Buffer.from('X'), aeskey));
    srv.pushMediaMessage('rex1', { msgid: 'ex1', userId: 'u1', kind: 'image', url: `${base}/gone.jpg`, aeskey });       // 404 = 过期 URL
    srv.pushMediaMessage('rbd1', { msgid: 'bd1', userId: 'u1', kind: 'image', url: `${base}/ok.bin`, aeskey: randomBytes(32).toString('base64') }); // bad key
    await waitUntil(() => streamsOf(srv).filter((s) => s.finish && s.content.includes('附件接收失败')).length === 2);
    expect(existsSync(join(stateDir, 'stdin.jsonl'))).toBe(false);                      // 零 spawn
    expect(readdirSync(join(ws, '.bot', 'sessions')).length).toBe(0);                   // 无会话生成
    expect(readdirSync(join(ws, '.bot', 'uploads'))).toEqual([]);                       // 无文件落盘（脚手架建的空目录）
  });
});

test('W4 未授权：陌生人媒体零下载零 spawn，拒绝文案送达', async () => {
  await withMedia(async ({ srv, files, base, stateDir }) => {
    srv.pushMediaMessage('rst1', { msgid: 'st1', userId: 'stranger', kind: 'image', url: `${base}/x.jpg`, aeskey: 'k' });
    await waitUntil(() => streamsOf(srv).some((s) => s.finish && s.content.includes('未被授权')));
    expect(existsSync(join(stateDir, 'stdin.jsonl'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run it — post-implementation PASS-only evidence gate** — Run: `bun test tests/integration/media.test.ts` Expected: PASS（Tasks 1–3 已实现全部行为，helper 与测试文件在本步前已落盘——本任务是验收证据固化）。任何 FAIL 即 Task 1–3 实现缺口：修实现，不改验收断言；唯二允许的 fixture 级修正：(a) axios 代理问题 ⇒ 确认文件头 NO_PROXY 行存在，(b) bun http server 关闭竞态 ⇒ 调整 stop() 兜底超时。
- [ ] **Step 3: 修正至全绿**（修实现不改验收断言；若 axios 代理问题致本地下载失败，固化 NO_PROXY 设置于测试文件头部）
- [ ] **Step 4: Run it and verify it PASSES** — Run: `bun test tests/integration/media.test.ts` Expected: PASS（5 tests）
- [ ] **Step 5: Commit** — `git add tests/helpers/media-file-server.ts tests/integration/media.test.ts && git commit -m "W4: end-to-end AC1-AC4 — real SDK download+decrypt via local encrypted file server, prompt-path evidence, failure surfaces"`

## Checkpoint C（Task 4 后）

- [ ] `bun run typecheck && bun test`（全量）通过
- [ ] AC1–AC4 各有集成证据且绿

### Task 5: SPEC.md 契约段 + README + follow-up issue + 交付门

**Files:**
- Modify: `SPEC.md`（追加「## 附件面（W4 契约）」段）
- Modify: `README.md`（媒体能力说明小节）

**Interfaces:**
- Consumes: Tasks 1–4 全部落定行为
- Produces: 文档契约 + mixed follow-up issue（GitHub）

- [ ] **Step 1: Write the docs**（`SPEC.md` 追加段）：

```md
## 附件面（W4 契约）

- 入站媒体（单聊 image/file/voice/video——平台契约；群只递送 text/mixed）：统一 `mediaMessage`
  事件（kind 判别联合 + url/aeskey **均可选**）。群类型媒体帧 debug 忽略（平台 single-chat only）；
  **缺 url/aeskey 的协议异常帧仍上抛事件**，由 handler 走失败错误面——绝不静默丢。
  `message.mixed` 维持未订阅——群图文混排 v1 不可用（known gap，follow-up issue 跟踪）。
- 下载解密：SDK 内建 `WSClient.downloadFile(url, aeskey)`（Q12——零自研 crypto；AES-256-CBC、
  IV=key 前 16 字节、PKCS#7 至 32 字节块）。分派序：群守卫 → access gate（未授权拒绝文案、
  **零下载**）→ 过期 ask 判定 → 缺 url/aeskey 守卫（长连接媒体恒加密，无 key 密文不得当附件——
  关键终帧短错误）→ 立即下载（url 5 分钟窗——排队/回合失败不吞噬下载窗，已授权附件先物化后
  消费）→ submit。媒体绝不喂 pending-ask 作答（不可能是数字/文字答案）。
- 落盘：`.bot/uploads/YYYY-MM-DD/`（本地时区）`<safeMsgid>-<消毒名>`（msgid 白名单消毒
  `[^A-Za-z0-9._-]→_`、≤64 字符）；文件名消毒剥路径分隔符/控制字符/换行（prompt 注入防线）、
  扩展保留后截断 ~120 UTF-8 字节；缺名 fallback `<safeMsgid>-<kind>.<ext>`（jpg/bin/amr/mp4）；
  同 msgid 重投递幂等覆盖（回合级不去重——msgid 排重是平台责任，与 text 路径同构）。
  30 天清理：启动 + 每 24 h 定时（删除严格早于当日−30 天零点的日期目录——恰 30 天保留），
  逐目录与读目录失败仅日志（ENOENT 静默——脚手架未建安全）。
- prompt 组装：image/file note 携绝对路径 + 字节数 + Read 工具提示；voice/video note 声明
  「已归档、内容无法解析（未做转写）」——SDK `VoiceContent.content`（ASR）**不使用**（转写 v2+）。
- 失败面：缺 url/aeskey、下载/解密 throw ⇒ 关键终帧短错误（有界等待 + 强制发送 + 逃逸记账——
  AC4 不走可丢弃 notice）+ ERROR 日志、不下载不 spawn；oversize（>100 MB，SDK 全量缓冲后判定）/
  空 buffer/落盘失败 ⇒ 降级 note 入 prompt、回合照跑、日志留痕——任何路径不静默丢。
- 已知未验证面（Human-Review 手工清单）：voice 帧运行时 url/aeskey 形状（.d.ts 只声明 content，
  adapter 防御式读取——缺失走失败错误路径）；image 真实格式；Content-Disposition 真实文件名
  形状；真实 agent 读图行为（prompt 契约已由集成测试锁定）。
```

`README.md` 快速开始/访问控制之后追加：

```md
### 附件（图片 / 文件 / 语音 / 视频）

私聊发送的图片与文件会被机器人下载解密并保存到 `<workspace>/.bot/uploads/YYYY-MM-DD/`，
随后交给 claude 处理（可直接查看图片与文件内容）。语音与视频仅归档——当前版本无法解析
其内容（转写属后续版本）。附件下载失败（如链接过期）会收到一条失败提示。文件保留 30 天
后自动清理。群聊内的图片消息（图文混排）当前版本暂不支持。
```

- [ ] **Step 2: File the follow-up issue（mixed 群图文）** — 首选 `mcp__github__create_issue`（owner `Jacky402615`，repo `wechatbot`，labels `["enhancement"]`，title `Group mixed-message support (group image via msgtype=mixed)`，body 见下）；无 MCP 时 fallback：
  ```bash
  gh issue create -R Jacky402615/wechatbot -l enhancement \
    -t "Group mixed-message support (group image via msgtype=mixed)" \
    -b "v1 known gap (wechatbot issue #4, decision D10): per platform spec groups deliver only text/mixed; mixed messages (group text+image combos) are not subscribed in v1, so group users cannot send images to the bot. Scope: subscribe message.mixed, extract text items (mention stripping reuse) + image items (download/decrypt reuse), batch into group session prompt. Depends on the W4 media module."
  ```
  验证：`gh issue view --json url`（或 MCP 返回的 html_url）拿到 issue URL。看板回写：用 `mcp__github__update_issue_comment`（comment_id = 本轮工作看板评论 ID——board 协议持久化的那个）在 `### 执行日志` 追加一行 `- follow-up(mixed): <issue URL>`；MCP 不可用时 `gh api repos/Jacky402615/wechatbot/issues/comments/<id> -X PATCH -f body="$(gh api repos/Jacky402615/wechatbot/issues/comments/<id> --jq .body)
- follow-up(mixed): <issue URL>"`。
- [ ] **Step 3: Verify docs against behavior** — Run: `bun test` + `bun run typecheck` + 通读 SPEC 新段与 Task 3/4 行为一一对照（每条契约可指回某测试）；**旧契约负检查**（防评审已废弃措辞回潮）：`! grep -q '缺 url 帧 debug 忽略' SPEC.md` 与 `! grep -qE '<kind>-<msgid>' SPEC.md docs/issues/4/plan.md` ——两条取反命令**退出码都必须为 0**（即底层 grep 无匹配、退出 1）才通过
- [ ] **Step 4: Full gate** — Run: `bun run typecheck && bun test && bun run build && bun run check:dist` Expected: 全部通过
- [ ] **Step 5: Commit** — `git add SPEC.md README.md && git commit -m "W4: SPEC attachment contract section + README media docs"`

## Checkpoint D（Task 5 后——交付门）

- [ ] `bun run typecheck && bun test && bun run build && bun run check:dist` 全绿
- [ ] AC1–AC4 各有集成测试且绿（tests/integration/media.test.ts + agent-handler 单测）
- [ ] 自审：scope 对照 issue 描述——chunked upload、transcription、mixed 群图文未做（out of scope 确认；mixed 已开 follow-up）
- [ ] **Human-Review 证据清单**（PR 描述携带空栏，owner 逐项填写后方可合并）：
  - 真机单聊发图：`uploads/YYYY-MM-DD/` 落盘解密成功 + agent 正确引用图片内容（AC1）：____
  - 真机单聊发文件（含中文名）：____
  - 真机发语音/视频：归档 + 不可解析声明回执：____（同时核对 voice 帧 url/aeskey 运行时形状——FLAGGED D12）
  - 真机过期链接/bad aeskey 场景错误回执：____（如难以构造，说明验证方式）

## Risk Notes

- **voice 帧运行时形状**（高不确定，FLAGGED D12）：SDK `.d.ts` 的 `VoiceContent` 只声明 `content`（ASR）；平台协议称携带 url+aeskey。adapter 防御式读取 `voice.url`/`voice.aeskey`——**缺 url 或缺 aeskey 都走 D8 错误面（关键终帧短错误），不下载不落盘**（无 key 的密文绝不冒充可解析附件）。fail-safe 方向：不误吞、不崩溃、不误导 agent。
- **msgid 不可信输入**：`safeMsgid` 白名单消毒（`[^A-Za-z0-9._-]→_`、≤64）——穿越/注入/超长在入路径与 prompt 前被拦；文件名消毒（D6）同防线。
- **回合级重投递不去重（接受并文档化）**：msgid 排重是平台责任（`aibot_msg_callback` 协议）；文件级幂等覆盖保磁盘不重复，同 msgid 重投递产生重复回合与 W1–W3 text 路径同构——不引入 app 级去重状态（新状态面超 issue 范围）。
- **SDK 全量缓冲内存尖峰**：axios arraybuffer 无流式截断，100 MB 帽在缓冲后判定——极端并发下多附件同时入站可致内存峰值（单聊媒体量小 + maxConcurrentTurns=4 间接限流；真流式帽需自研下载，违反 Q12，不做）。
- **axios 环境代理**：CI 沙箱若设 `HTTP_PROXY`，SDK 的 axios 实例可能代理本地地址致集成测试失败——media.test.ts 头部固化 `NO_PROXY=127.0.0.1,localhost`（保存原值 afterAll 还原）。
- **W1–W3 测试基线**：`WeComTransport` 扩员已同 commit 迁移 FakeTransport（Task 2）；handler deps 扩员同 commit 迁移两个 fixture（Task 3）——Checkpoint A/B 全量 `bun test` 是护栏。
- **加密镜像漂移**：测试侧 `encryptMedia` 与 SDK `decryptFile` 互逆——SDK 升版若改 PKCS#7/IV 语义，集成测试立即红（pin 1.0.7 + Checkpoint A 核验 + 测试即契约锚点）。
- **`.bot/uploads` 不会入库**：`.gitignore` 已含 `.bot/`（`git check-ignore .bot/uploads` 命中）——Checkpoint B 复核一次即可。
