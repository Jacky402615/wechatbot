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
