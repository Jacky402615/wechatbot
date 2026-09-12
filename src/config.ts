import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
    writeFileSync(envPath, 'WECOM_BOT_ID=\nWECOM_SECRET=\n');
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
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new ConfigError(`${numKey} must be a number in ${path}`);
      }
      cfg[numKey] = v;
    }
  }
  return cfg;
}
