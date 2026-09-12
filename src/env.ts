import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export class EnvError extends Error {}

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export interface BotCredentials { botId: string; secret: string }

export function loadBotEnv(botDir: string): BotCredentials {
  const envPath = join(botDir, '.env');
  const values = parseEnvFile(readFileSync(envPath, 'utf8'));
  const missing = ['WECOM_BOT_ID', 'WECOM_SECRET'].filter((k) => values[k] === undefined);
  if (missing.length > 0) {
    throw new EnvError(`missing ${missing.join(', ')} in ${envPath}`);
  }
  return { botId: values['WECOM_BOT_ID'] ?? '', secret: values['WECOM_SECRET'] ?? '' };
}

export function assertCredentials(creds: BotCredentials, envPath: string): void {
  const empty = (['botId', 'secret'] as const).filter((k) => creds[k] === '');
  if (empty.length > 0) {
    const keyName = empty.map((k) => (k === 'botId' ? 'WECOM_BOT_ID' : 'WECOM_SECRET')).join(', ');
    throw new EnvError(`${keyName} is empty — fill it in ${envPath}`);
  }
}
