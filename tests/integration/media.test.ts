import { test, expect, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
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
  mkdirSync(stateDir, { recursive: true });
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
