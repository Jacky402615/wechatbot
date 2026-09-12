import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadBotEnv, type BotCredentials } from './env';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface BotConfig {
  logLevel: LogLevel;
  heartbeatInterval?: number;
  maxReconnectAttempts?: number;
  /** W2：会话空闲 TTL（分钟）——issue 原文键名，SRS 键名优先于仓库 camelCase 风格；缺省值由 AgentManager 持有 */
  sessionIdleTtlMinutes?: number;
  /** W2：claude --model 值（trim 后非空）；缺省 glm-5.3-flash 由 AgentManager 持有 */
  claudeModel?: string;
  /** W2：全局并发回合帽（资源保护；平台每用户帽是 manager 常量）；缺省 4 由 AgentManager 持有 */
  maxConcurrentTurns?: number;
  /** W3：群 @-提及匹配名（D3——真实平台 @ 文案内嵌 content，SDK 无 mention 字段）；
   *  groups 非空时必填（启动交叉校验在 createGateway——config 不读 access.json） */
  groupMentionName?: string;
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
  ensureWorkspaceTree(botDir);
  const config = parseConfig(readFileSync(join(botDir, 'config.json'), 'utf8'), join(botDir, 'config.json'));
  const creds = loadBotEnv(botDir);
  return { workspace, botDir, config, creds };
}

/** 幂等创建 .bot 目录树与模板文件（不解析 config——管理面也能安全调用） */
export function ensureWorkspaceTree(botDir: string): void {
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
  const ttl = raw['session_idle_ttl_minutes'];
  if (ttl !== undefined) {
    if (typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl <= 0) {
      throw new ConfigError(`session_idle_ttl_minutes must be an integer > 0 in ${path}`);
    }
    cfg.sessionIdleTtlMinutes = ttl;
  }
  const turns = raw['maxConcurrentTurns'];
  if (turns !== undefined) {
    if (typeof turns !== 'number' || !Number.isInteger(turns) || turns <= 0) {
      throw new ConfigError(`maxConcurrentTurns must be an integer > 0 in ${path}`);
    }
    cfg.maxConcurrentTurns = turns;
  }
  const model = raw['claudeModel'];
  if (model !== undefined) {
    if (typeof model !== 'string' || model.trim() === '') {
      throw new ConfigError(`claudeModel must be a non-empty string in ${path}`);
    }
    cfg.claudeModel = model.trim();
  }
  const mention = raw['groupMentionName'];
  if (mention !== undefined) {
    if (typeof mention !== 'string' || mention.trim() === '') {
      throw new ConfigError(`groupMentionName must be a non-empty string in ${path}`);
    }
    cfg.groupMentionName = mention.trim();
  }
  return cfg;
}
