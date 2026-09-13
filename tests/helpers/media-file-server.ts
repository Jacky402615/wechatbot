import { createServer, type Server } from 'node:http';
import { createCipheriv } from 'node:crypto';

/** SDK decryptFile 的互逆镜像（AES-256-CBC、IV=key 前 16 字节、PKCS#7 填充至 32 字节块）。
 *  测试侧加密——Q12 禁的是产品路径自研 crypto；SDK 版本已 pin 1.0.7（package.json + Checkpoint A 核验）。 */
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
    this.srv.listen(0, '127.0.0.1');
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
