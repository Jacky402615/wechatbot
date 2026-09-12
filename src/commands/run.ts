import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { createGateway, type Gateway } from '../gateway';
import { EnvError, } from '../env';
import { ConfigError } from '../config';
import { writePidFile, readPidFile } from '../pid';

export async function run(opts: { workspace: string }): Promise<number> {
  let gateway: Gateway;
  let botDir: string;
  try {
    ({ gateway, workspace: { botDir } } = await createGateway(opts.workspace));
  } catch (e) {
    if (e instanceof EnvError || e instanceof ConfigError) {
      process.stderr.write(`[wechatbot] 启动失败（凭据/配置）: ${e.message}\n`);
      return 1; // AC1：响亮失败，非零退出
    }
    process.stderr.write(`[wechatbot] 启动失败: ${(e as Error).message}\n`);
    return 1;
  }
  const pidPath = join(botDir, 'gateway.pid');
  // 信号句柄先于 start 注册：start 期间收到 SIGTERM 也能优雅退出
  let stopping = false;
  const cleanupPidFile = (): void => {
    const entry = readPidFile(pidPath);
    if (entry && entry.pid === process.pid) rmSync(pidPath, { force: true });
  };
  const shutdown = (sig: string) => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`[wechatbot] 收到 ${sig}，正在优雅关闭…\n`);
    gateway.stop()
      .catch((e: unknown) => {
        // 关闭失败必须可见且非零退出（feishubot #62：不吞）
        process.stderr.write(`[wechatbot] 优雅关闭失败: ${(e as Error).message}\n`);
        process.exitCode = 1;
      })
      .finally(() => {
        cleanupPidFile();
        process.exit(process.exitCode ?? 0);
      });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  try {
    await gateway.start();
  } catch (e) {
    process.stderr.write(`[wechatbot] 网关启动失败: ${(e as Error).message}\n`);
    return 1;
  }
  // 前台运行也持有 pidfile：status/stop 才能对 run 模式给出真实连接状态
  try {
    writePidFile(pidPath, process.pid);
  } catch (e) {
    process.stderr.write(`[wechatbot] pidfile 写入失败（status 将不可见）: ${(e as Error).message}\n`);
  }
  return new Promise<never>(() => undefined); // 前台常驻，直到信号
}
