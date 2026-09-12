import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '../../src/gateway';
import { MockWecomServer } from '../helpers/mock-wecom-server';

const SOAK_MS = 10 * 60 * 1000;    // AC2: ≥10 min
const KILL_AT = 5 * 60 * 1000;
const OUTAGE_GRACE_MS = 30_000;    // kill 后允许的最长失联窗口（重连退避 + 余量）

test('soak: 10 min 持续存活 + 中途断链有界恢复（AC2）', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'wb-soak-'));
  const { loadWorkspace } = await import('../../src/config');
  loadWorkspace(ws); // 首启建树
  writeFileSync(join(ws, '.bot', '.env'), 'WECOM_BOT_ID=b\nWECOM_SECRET=s\n');
  const srv = new MockWecomServer();
  const { url } = await srv.start();
  const { gateway } = await createGateway(ws, {
    wsUrl: url,
    heartbeatInterval: 30_000,     // 真实心跳间隔
    reconnectInterval: 200,
    maxReconnectAttempts: -1,
  });
  await gateway.start();

  const t0 = Date.now();
  let killed = false;
  let killAt = 0;
  let recoveredAt = 0;
  let outageViolations = 0;
  let livenessSamples = 0;
  let aliveSamples = 0;

  const sampler = setInterval(() => {
    livenessSamples += 1;
    const alive = gateway.isConnected();
    if (alive) {
      aliveSamples += 1;
      if (killed && !recoveredAt) recoveredAt = Date.now();
    }
    // 恢复后必须持续在线；kill 后超过宽限期仍未恢复即违规
    if (killed && !alive && Date.now() - killAt > OUTAGE_GRACE_MS) outageViolations += 1;
  }, 1_000);
  const killer = setInterval(() => {
    if (!killed && Date.now() - t0 >= KILL_AT) { killed = true; killAt = Date.now(); srv.kill(); }
  }, 1000);

  try {
    while (Date.now() - t0 < SOAK_MS) await new Promise((r) => setTimeout(r, 5_000));
  } finally {
    clearInterval(sampler);
    clearInterval(killer);
  }

  // 心跳：10 min / 30 s ≈ 20 次，容差 -2（边界抖动）
  expect(srv.pingCount).toBeGreaterThanOrEqual(Math.floor(SOAK_MS / 30_000) - 2);
  expect(killed).toBe(true);
  expect(srv.subscribeCount).toBeGreaterThanOrEqual(2);          // kill 后重新 subscribe
  expect(recoveredAt).toBeGreaterThan(0);                        // 恢复时间点被观测到
  expect(recoveredAt - killAt).toBeLessThanOrEqual(OUTAGE_GRACE_MS); // 恢复在有界窗口内
  // 退避证据：重订阅发生在 kill 之后至少一个 reconnectInterval（非立即重试）
  const resubscribeDelay = (srv.subscribeTimes[srv.subscribeTimes.length - 1] ?? 0) - killAt;
  expect(resubscribeDelay).toBeGreaterThanOrEqual(200);          // = soak 配置的 reconnectInterval
  expect(outageViolations).toBe(0);                               // 恢复后无再次失联
  const deadSamples = livenessSamples - aliveSamples;
  const killWindowSamples = Math.ceil((recoveredAt - killAt) / 1_000) + 2; // 容差
  expect(deadSamples).toBeLessThanOrEqual(killWindowSamples);    // 失联样本只出现在 kill 窗口内
  console.log(JSON.stringify({ soakMs: Date.now() - t0, pings: srv.pingCount, subscribes: srv.subscribeCount, outageMs: recoveredAt - killAt, resubscribeDelayMs: resubscribeDelay }));
  await gateway.stop();
  await srv.stop();
}, SOAK_MS + 120_000);
