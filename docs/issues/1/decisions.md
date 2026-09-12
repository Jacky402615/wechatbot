# decisions.md — issue 1（Gateway skeleton: WeCom 长连接 transport + stream echo）

- 日期：2026-09-13（r1，self-grill + codex-eval `kind=options` 一轮）
- 评审结论：`needs-attention`（11 项建议全部为「采纳并强化」，无方案级否决）
- 依据：issue 描述（内嵌 SRS 节）+ `@wecom/aibot-node-sdk@1.0.7` `.d.ts` 实测解析 + 空仓勘察

## D1: Adapter 接口形态

**选定 (a)：单一自有 `WeComTransport` port** —— `start()/stop()/onEvent(kind, cb)/replyStream(reqRef, streamId, content, finish)/isConnected` + 自有 DTO（`InboundTextMessage` 等）；`WSClient` 只在唯一实现 `src/transport/wecom-sdk-adapter.ts` 内构造。
理由：AC6 要求换 SDK 只动 adapter；自有 DTO 隔离 SDK 类型漂移。(b) 重新导出 SDK 类型会泄漏供应商变化；(c) 多 port 拆分对 W1 过度设计。
Codex 异议：无（confidence 0.94 赞同）。

## D2: 重连归属

**选定 (a)：依赖 SDK 内建重连** —— `maxReconnectAttempts: -1`（无限），基础间隔用 SDK 默认；adapter 只观察并记录 `reconnecting`/`disconnected`/`error`；`disconnected_event`（被踢）→ 醒目 ERROR 日志后让 SDK 自动重连（重新 subscribe）；致命 `WSAuthFailureError` → ERROR 日志 + 非零退出码（AC1）。
理由：自建 supervisor 会重造认证/重连竞态。
Codex 强化条件（采纳）：**SPEC.md 中关于退避/恢复的描述只能写集成测试实际验证到的行为**——SDK `config.d.ts` 自述"实际延迟按指数退避递增"，但我们的契约文本以 mock 服务端测试观察为准；kicked → 重新订阅必须有集成测试证明，未证明前不写进契约。
Codex 标注 INFORMATION GAP（记录，不阻塞）：真实 WeCom 的 kicked/认证语义最终需真实凭据，列入 Human-Review 手工清单。

## D3: `status` 机制（AC5）

**选定 (a)：状态文件** —— 守护进程与 `run` 前台进程都写 `.bot/state.json`（`pid/running/connected/updatedAt/lastError/kickedCount/reconnects/lastEventAt`），**原子写**（tmp + rename）；`status` 读文件 + pid 存活/归属校验。
理由：可测试、无守护进程也能工作。
Codex 强化条件（采纳）：原子写、含 `updatedAt`/`lastError`、防 pid 复用误报。(b) 解析日志脆弱；(c) IPC 对只读命令过重。
**r1 plan 评审修订（codex round 2）**：pidfile 升级为 JSON `{pid, startedAt}`，`startedAt` 取 `/proc/<pid>/stat` 第 22 字段（进程启动时钟滴答；非 Linux 平台返回 null 则跳过归属校验）——`stop`/`status` 仅在 pid 存活**且** startedAt 匹配时认定"是我们的网关"，防 pid 复用误杀；`status` 在 pid 已死时把 `running/connected` 归一为 false 并标 `stale: true`，不输出"僵尸 connected"。

## D4: 守护进程化（start/stop）

**选定 (a)：分离子进程** —— `start` 用 `spawn`（detached + unref，stdio 重定向到 `.bot/logs/`），pidfile `.bot/gateway.pid`；`stop` = SIGTERM → 优雅关闭 WS → 超时后 SIGKILL → 清理 pidfile 与陈旧状态。
理由：issue 钦定 CLI 形态镜像 feishubot（无 systemd 依赖）；沙箱无特权。
Codex 强化条件（采纳）：SIGTERM 超时升级 SIGKILL、陈旧 state 清理。

## D5: 无真实凭据的测试策略

**选定 (a)：mock WeCom WS 服务端** —— devDep `ws` 起本地服务端，按帧协议应答（`aibot_subscribe`→`{errcode:0}`、`ping`→`{errcode:0}`、推送 `aibot_msg_callback`、主动断链、推送 `disconnected_event`），SDK `wsUrl` 指向它。自动化覆盖 AC1（错 secret）、AC2（断链重连，压缩心跳间隔）、AC3（被踢恢复）、AC4（echo finish=true）。
**Soak 策略（显式化）**：默认 `bun test` 排除 soak；独立 `test:soak` 脚本（10 min、真实 30 s 心跳、对 mock 服务端）；Build 阶段执行一次并记录看板。
**FLAGGED-FOR-HUMAN**：AC2/AC3/AC4 的真实 WeCom 端验证需凭据——Human-Review 手工清单项（真实 secret 连接、真实 soak、真实单聊 echo），沙箱内以 mock 服务端测试为等效证据。
(b) 只 mock SDK 类无法验证线上行为；(c) 录制回放无法覆盖动态重连。

## D6: Echo 帧形态

**选定 (a)：单帧** —— 一次 `replyStream(frame, streamId, 全文, finish=true)`，req_id 由 frame 透传。
理由：AC4 措辞"a streamed echo reply terminating finish=true"——走 stream 协议且以 finish=true 终止，单帧即满足且最稳。(b) 人为拆两帧引入无需求的分片失败面。
Codex 异议：无（confidence 0.93 赞同）；多帧流式属 W2 agent 层，adapter 的 `replyStream` 天然支持。

## D7: 日志栈

**选定 (a)：自研极简结构化 logger** —— JSONL 写 `.bot/logs/gateway-YYYYMMDD.jsonl` + 控制台镜像；级别来自 `config.json`；实现 SDK `Logger` 接口（debug/info/warn/error）。
Codex 强化条件（采纳）：append 错误处理、关闭时 flush、保留策略显式文档化——**按日切文件，启动时清理 >14 天的旧文件**。
(b) pino / (c) winston：依赖与 Bun 兼容面不值得。

## D8: 打包 + 发布管道

**选定 (a)：bun build + GitHub Actions** —— `bun build --target=node --external @wecom/aibot-node-sdk`（node 内建外部化），`ci.yml`（`bun test` + `tsc --noEmit` + **dist 机器路径 grep（AC6）** + **dist CLI 冒烟**：构建后 `bun dist/cli.js --help` 与 `node dist/cli.js --help` 双跑，node 侧强制），`publish.yml`（tag push → `npm publish --registry=https://npm.pkg.github.com`，`NODE_AUTH_TOKEN`，package.json `publishConfig` + `bin`/`files` 正确声明）。
**r1 plan 评审修订（codex round 2）**：`--target=node`（而非 bun）——dist 同时可被 bun/node 执行，`bin` 入口 shebang 用 `#!/usr/bin/env node`，src/ 全程 node 内建 API（`import.meta.main` 等 Bun 专属入口判断一并替换为可移植写法）。**SDK 版本钉死 `1.0.7`（无 `^`）**——W1 行为以该版 .d.ts 与运行时实测为准，浮动手范围引入未测变量。
Codex 标注 INFORMATION GAP（记录，不阻塞）：registry 可见性与 token 可用性需仓库设置/凭据才能端到端验证——W1 交付物是"管道文件"，真实发布验证列入 Human-Review 清单。

## D9: CLI 解析

**选定 (a)：手写 argv 解析** —— 仅 `run|start|stop|status` + `-r <workspace>` + `-h/--help`，未知/缺失/重复参数报错退出非零。
(b) cliffy /(c) commander 对 4 命令面是纯成本。

## D10: `.bot/` 配置面（W1）

**选定 (a)：首启自动建目录树** —— `config.json`：`{ logLevel, heartbeatInterval?, maxReconnectAttempts? }`（有校验）；`access.json` 建为 `{}` 占位（解析但 W1 不用，实际用途 W3）；`sessions/ uploads/ logs/` 空目录。
Codex 修正（采纳，关键）：**显式解析 `<workspace>/.bot/.env`**（自研极简 parser，不依赖 Bun 只从 CWD 自动加载的行为）——`-r <workspace>` 场景下凭据必须可靠加载，否则 AC1 会以错误方式失败。
Codex 修正（采纳）：**去掉 `reconnectOnKicked` 开关**——置 false 可绕过 AC3，W1 硬编码 kicked → 重连。

## D11: 进程模型

**选定 (a)：薄 `Gateway` 类** —— 持有 `{ transport, logger, stateWriter, handlers }`；W1 注册 `EchoHandler`；W2 换 `SessionHandler` 不动骨架。
(b) echo 直写 main 会把生命周期/协议耦合进入口；(c) DI 容器对 W1 是仪式感。

## D12: `WECOM_WS_URL` 环境变量覆盖面（r1 plan 评审新增）

**选定：保留，但明确信任边界** —— `createGateway` 允许环境变量 `WECOM_WS_URL` 覆盖 SDK 连接地址（测试与高级部署用：自建代理/私有化入口）。
理由：CLI 子进程级集成测试（AC1 端到端）无法用编程注入，必须走环境变量。
Codex 风险指出（采纳缓解）：该变量可把 `WECOM_SECRET` 重定向到任意 WS 端点——**信任假设：进程环境属运维控制面，能改环境者本就有进程控制权**。落地约束：SPEC.md 归入"高级/测试"节并写明此信任假设；README 快速开始**不**提及该变量。
备选（否决）：纯编程注入 + 砍掉 CLI 级 AC1 子进程测试——为小面安全观牺牲端到端验证，不值。

## 评审缺失记录

- 无。codex 调用记录：`options` 轮 ×1（verdict: needs-attention，11 项建议全部采纳/强化）；`plan` 轮 ×3（均 needs-attention：R1 14 项结构性缺陷、R2 12 项机械缺陷、R3 7 项收尾缺陷——三轮 findings 已全部修复进 plan.md）。
- 说明：第 3 轮评审先于其 7 项修复执行（轮次预算 3 已用尽），修复后未再跑第 4 轮复验；残余风险由 Step 3.5 自审清单 + 执行阶段 Checkpoint A/B/C 的 full gate 兜底。
