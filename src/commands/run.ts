import { createGateway, type Gateway } from '../gateway';
import { EnvError } from '../env';
import { ConfigError } from '../config';

export async function run(opts: { workspace: string }): Promise<number> {
  let gateway: Gateway;
  try {
    ({ gateway } = await createGateway(opts.workspace));
  } catch (e) {
    if (e instanceof EnvError || e instanceof ConfigError) {
      process.stderr.write(`[wechatbot] 启动失败（凭据/配置）: ${e.message}\n`);
      return 1; // AC1：响亮失败，非零退出
    }
    process.stderr.write(`[wechatbot] 启动失败: ${(e as Error).message}\n`);
    return 1;
  }
  // 信号句柄先于 start 注册：start 期间收到 SIGTERM 也能优雅退出
  let stopping = false;
  const shutdown = (sig: string) => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`[wechatbot] 收到 ${sig}，正在优雅关闭…\n`);
    void gateway.stop().finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  try {
    await gateway.start();
  } catch (e) {
    process.stderr.write(`[wechatbot] 网关启动失败: ${(e as Error).message}\n`);
    return 1;
  }
  return new Promise<never>(() => undefined); // 前台常驻，直到信号（Promise<never> 可赋给 Promise<number>）
}
