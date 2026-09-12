import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadBotEnv, type BotCredentials } from './env';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface BotConfig {
  logLevel: LogLevel;
  heartbeatInterval?: number;
  maxReconnectAttempts?: number;
}

export class ConfigError extends Error {}

const DEFAULT_CONFIG: BotConfig = { logLevel: 'info' };

export interface Workspace {
  workspace: string;
  botDir: string;
  config: BotConfig;
  creds: BotCredentials;
}

export function loadWorkspace(workspace: string): Workspace {
  const botDir = join(workspace, '.bot');
  mkdirSync(join(botDir, 'sessions'), { recursive: true });
  mkdirSync(join(botDir, 'uploads'), { recursive: true });
  mkdirSync(join(botDir, 'logs'), { recursive: true });
  const accessPath = join(botDir, 'access.json');
  if (!existsSync(accessPath)) writeFileSync(accessPath, '{}\n');
  const configPath = join(botDir, 'config.json');
  if (!existsSync(configPath)) writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
  const envPath = join(botDir, '.env');
  if (!existsSync(envPath)) {
    // 凭据文件：创建即 0600，避免 WECOM_SECRET 被 同机其他用户读取
    writeFileSync(envPath, 'WECOM_BOT_ID=\nWECOM_SECRET=\n', { mode: 0o600 });
  } else {
    try {
      if (statSync(envPath).mode & 0o077) chmodSync(envPath, 0o600); // 修复宽松权限
    } catch (e) {
      // fail-closed：凭据仍暴露时拒绝继续读取/启动
      throw new ConfigError(`cannot tighten ${envPath} perms to 0600: ${(e as Error).message}`);
    }
  }
  const config = parseConfig(readFileSync(configPath, 'utf8'), configPath);
  const creds = loadBotEnv(botDir);
  return { workspace, botDir, config, creds };
}

function parseConfig(text: string, path: string): BotConfig {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch (e) {
    throw new ConfigError(`invalid JSON in ${path}: ${(e as Error).message}`);
  }
  const cfg: BotConfig = { ...DEFAULT_CONFIG };
  if (raw['logLevel'] !== undefined) {
    if (!['debug', 'info', 'warn', 'error'].includes(raw['logLevel'] as string)) {
      throw new ConfigError(`logLevel must be debug|info|warn|error in ${path}`);
    }
    cfg.logLevel = raw['logLevel'] as LogLevel;
  }
  for (const numKey of ['heartbeatInterval', 'maxReconnectAttempts'] as const) {
    const v = raw[numKey];
    if (v !== undefined) {
      if (typeof v !== 'number' || !Number.isInteger(v)) {
        throw new ConfigError(`${numKey} must be an integer in ${path}`);
      }
      if (numKey === 'heartbeatInterval' && v <= 0) {
        throw new ConfigError(`heartbeatInterval must be > 0 in ${path}`);   // 0/负数 = 心跳热循环
      }
      if (numKey === 'maxReconnectAttempts' && v < -1) {
        throw new ConfigError(`maxReconnectAttempts must be -1 (infinite) or >= 0 in ${path}`);
      }
      cfg[numKey] = v;
    }
  }
  return cfg;
}
