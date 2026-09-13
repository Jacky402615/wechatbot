import { mkdirSync, lstatSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export type MediaKind = 'image' | 'file' | 'voice' | 'video';

/** D8 防御帽：平台本就限 100 MB 入站——SDK 全量缓冲后判定的双保险（内存尖峰见 plan Risk Notes） */
export const MAX_MEDIA_BYTES = 100 * 1024 * 1024;

const FALLBACK_EXT: Record<MediaKind, string> = { image: 'jpg', file: 'bin', voice: 'amr', video: 'mp4' };
const NAME_BUDGET_BYTES = 120;
const RETENTION_DAYS = 30;
const PRUNE_INTERVAL_MS = 24 * 60 * 60_000;
const DATE_DIR_RE = /^\d{4}-\d{2}-\d{2}$/;
const MSGID_MAX = 64;

const KIND_LABEL: Record<MediaKind, string> = { image: '图片', file: '文件', voice: '语音', video: '视频' };

/** msgid 是平台输入（不可信）：字符集白名单 + 长度帽——直入文件路径/prompt 前会穿越/注入。
 *  替换/截断是**有损**变换：一旦发生即追加原始 msgid 的短哈希后缀（`~<8>`），
 *  使不同原始 msgid 不因消毒折叠成同一存储身份（code-review C-F1）；
 *  未受损的常规 msgid 原样保留（可读性优先）。空串产出占位。 */
export function safeMsgid(msgid: string): string {
  const safe = msgid.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, MSGID_MAX);
  if (safe !== '' && safe === msgid) return safe; // 未受损的常规 msgid 原样（空串仍走占位+哈希）
  const h = createHash('sha256').update(msgid).digest('base64url').slice(0, 8);
  const room = Math.max(MSGID_MAX - 9, 1);
  return `${safe.slice(0, room) || '_'}~${h}`;
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
      // code-review C-F2：只删真实目录——日期形的普通文件/符号链接不动（rmSync force 会吞掉它们）
      let st;
      try {
        st = lstatSync(join(this.uploadsDir, e), { throwIfNoEntry: false });
      } catch {
        continue;
      }
      if (!st?.isDirectory()) continue;
      // code-review C-F2：日历往返校验——'2026-02-30' 被 Date 归一到 3 月，非真实日期不动
      const [y, mo, d] = e.split('-').map(Number) as [number, number, number];
      const dirDate = new Date(y!, mo! - 1, d!);
      if (Number.isNaN(dirDate.getTime()) || dirDate.getFullYear() !== y! || dirDate.getMonth() !== mo! - 1 || dirDate.getDate() !== d!) continue;
      if (dirDate >= cutoff) continue;
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
