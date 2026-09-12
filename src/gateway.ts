import { join } from 'node:path';
import { loadWorkspace, type Workspace, ConfigError } from './config';
import { BotLogger } from './logger';
import { writeState, StateError, type GatewayState } from './state';
import { WecomSdkTransport } from './transport/wecom-sdk-adapter';
import type { TransportOptions, WeComTransport } from './transport/types';
import { assertCredentials, EnvError } from './env';
import { AgentHandler } from './handlers/agent';
import { AgentManager, type ClaudeCommand } from './agent/manager';
import { SessionStore } from './agent/session-store';

/** W2：消息面 handler 契约（AgentHandler 实现；测试注入桩） */
export interface BotHandler { register(): void; stop?(): Promise<void> }

export class Gateway {
  private state: GatewayState;
  private stopped = false;
  private fatalCallbacks: Array<(err: Error) => void> = [];

  constructor(private opts: { transport: WeComTransport; logger: BotLogger; botDir: string; pid?: number; handler: BotHandler }) {
    this.state = {
      pid: opts.pid ?? process.pid, running: true, connected: false, authenticated: false,
      updatedAt: new Date().toISOString(), kickedCount: 0, reconnects: 0,
    };
    this.opts.transport.on((event) => this.onEvent(event));
  }

  /** 致命错误（如自愈期认证耗尽）：宿主应停机并响亮退出 */
  onFatal(cb: (err: Error) => void): void {
    this.fatalCallbacks.push(cb);
  }

  async start(): Promise<void> {
    // handler 必须先于 transport.start() 注册：认证完成的瞬间 handler 已就位，
    // 消除"authenticated 与注册之间"的丢消息窗口（W1 既有语义）。
    this.opts.handler.register();
    try {
      await this.opts.transport.start();
    } catch (e) {
      this.state.lastError = (e as Error).message;
      this.opts.logger.error('gateway start failed', { err: (e as Error).message });
      throw e;
    }
    this.persist({ connected: true, authenticated: true });
    this.opts.logger.info('gateway started', { pid: this.state.pid });
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.opts.handler.stop?.().catch((e: unknown) => {
      // handler 停机失败可见，但不得阻断 transport 关闭（feishubot #62：不吞）
      this.opts.logger.error('handler stop failed', { err: (e as Error).message });
    });
    await this.opts.transport.stop();
    this.persist({ running: false, connected: false, authenticated: false });
    this.opts.logger.info('gateway stopped', { pid: this.state.pid });
  }

  /** agent 层失败入口（F8）：与 transport error 事件同道持久化 lastError */
  recordAgentError(err: Error): void {
    this.onEvent({ type: 'error', error: err });
  }

  isConnected(): boolean {
    return this.opts.transport.isConnected();
  }

  private onEvent(event: TransportEventLike): void {
    switch (event.type) {
      case 'connected':
        this.persist({ connected: true });
        break;
      case 'authenticated':
        this.persist({ connected: true, authenticated: true });
        break;
      case 'disconnected':
        this.persist({ connected: false, authenticated: false });
        this.opts.logger.warn('transport disconnected', { reason: event.reason });
        break;
      case 'reconnecting':
        this.persist({ reconnects: this.state.reconnects + 1 });
        this.opts.logger.warn('transport reconnecting', { attempt: event.attempt });
        break;
      case 'kicked':
        this.persist({ kickedCount: this.state.kickedCount + 1, lastError: 'kicked by new connection' });
        this.opts.logger.error('kicked: another connection took over; auto re-subscribing');
        break;
      case 'error':
        this.persist({ lastError: event.error.message });
        this.opts.logger.error('transport error', { err: event.error.message });
        break;
      case 'fatal':
        this.persist({ lastError: event.error.message, running: false });
        this.opts.logger.error('fatal transport error, gateway cannot continue', { err: event.error.message });
        for (const cb of this.fatalCallbacks) {
          try {
            cb(event.error);
          } catch (e) {
            this.opts.logger.error('fatal callback crashed', { err: (e as Error).message });
          }
        }
        break;
      case 'textMessage':
        this.persist({ lastEventAt: new Date().toISOString() });
        break;
    }
  }

  private persist(patch: Partial<GatewayState>): void {
    this.state = { ...this.state, ...patch, updatedAt: new Date().toISOString() };
    try {
      writeState(this.opts.botDir, this.state);
    } catch (e) {
      // StateError：状态面写失败不拖垮消息面，但必须留痕（不吞）
      if (e instanceof StateError) {
        this.opts.logger.error('state persist failed', { err: e.message });
      } else {
        throw e;
      }
    }
  }
}

type TransportEventLike = Parameters<Parameters<WeComTransport['on']>[0]>[0];

export interface AgentOverrides {
  claudeCommand?: ClaudeCommand;
  idleTtlMs?: number;
  turnTimeoutMs?: number;
  refreshIntervalMs?: number;
  maxConcurrentTurns?: number;
}

export async function createGateway(
  workspace: string,
  overrides: Partial<TransportOptions> = {},
  agent: AgentOverrides = {},
): Promise<{ gateway: Gateway; workspace: Workspace }> {
  let ws: Workspace;
  try {
    ws = loadWorkspace(workspace);
  } catch (e) {
    // 键缺失/配置损坏发生在 logger 构造之前——用兜底 logger 留 JSONL 痕迹再抛（AC1 可观测性）
    if (e instanceof EnvError || e instanceof ConfigError) {
      const fallback = new BotLogger({ level: 'info', logDir: join(workspace, '.bot', 'logs'), console: false });
      fallback.error('startup failed: credentials/config', { err: e.message });
    }
    throw e;
  }
  const logger = new BotLogger({ level: ws.config.logLevel, logDir: join(ws.botDir, 'logs'), console: true });
  try {
    assertCredentials(ws.creds, join(ws.botDir, '.env'));   // 空凭据在此响亮失败（AC1 前置）
  } catch (e) {
    logger.error('startup failed: credentials', { err: (e as Error).message });  // 结构化 ERROR 留痕，再抛
    throw e;
  }
  const wsUrl = process.env['WECOM_WS_URL'] ?? overrides.wsUrl;
  const transport = new WecomSdkTransport({
    botId: ws.creds.botId,
    secret: ws.creds.secret,
    heartbeatInterval: ws.config.heartbeatInterval,
    maxReconnectAttempts: ws.config.maxReconnectAttempts,
    logger: logger.asSdkLogger(),
    ...overrides,
    ...(wsUrl ? { wsUrl } : {}),
  });
  const sessions = new SessionStore(join(ws.botDir, 'sessions'), {
    onTelemetryError: (err, what) => logger.warn('session telemetry write failed', { what, err: err.message }),
  });
  const manager = new AgentManager({
    workspacePath: workspace, sessions, logger,
    options: {
      idleTtlMs: ws.config.sessionIdleTtlMinutes !== undefined ? ws.config.sessionIdleTtlMinutes * 60_000 : undefined,
      maxConcurrentTurns: ws.config.maxConcurrentTurns,
      model: ws.config.claudeModel,
      ...(agent.claudeCommand ? { claudeCommand: agent.claudeCommand } : {}),
      ...(agent.idleTtlMs !== undefined ? { idleTtlMs: agent.idleTtlMs } : {}),
      ...(agent.turnTimeoutMs !== undefined ? { turnTimeoutMs: agent.turnTimeoutMs } : {}),
      ...(agent.maxConcurrentTurns !== undefined ? { maxConcurrentTurns: agent.maxConcurrentTurns } : {}),
    },
  });
  let gatewayRef: Gateway | null = null;
  const handler = new AgentHandler({ transport, logger, manager, workspace }, {
    onReplyError: (e) => gatewayRef?.recordAgentError(e),   // F8：agent 失败进 state.json lastError
    ...(agent.refreshIntervalMs !== undefined ? { refreshIntervalMs: agent.refreshIntervalMs } : {}),
  });
  const gateway = new Gateway({ transport, logger, botDir: ws.botDir, handler });
  gatewayRef = gateway;
  return { gateway, workspace: ws };
}
