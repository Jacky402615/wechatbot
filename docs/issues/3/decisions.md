# decisions.md — issue 3（Commands, access control, group policy, welcome）

- 日期：2026-09-13（r1，self-grill + codex-eval `kind=options` 一轮）
- 评审结论：`needs-attention`（10 项裁定全部方向性同意，其中多项附实质强化，全部采纳；2 项列 FLAGGED-FOR-HUMAN）
- 依据：issue 描述（内嵌 SRS 节）+ feishubot 生产源码实测（`/home/ubuntu/wiki-symphony-ws/projects/feishubot`：`src/gateway/access.ts`/`commands.ts`/`inbound.ts`）+ `@wecom/aibot-node-sdk@1.0.7` `.d.ts`/README 实测 + W1/W2 代码勘察

## D1: 入站分派架构

**选定 (a)+强化：AgentHandler.onText 顶部扩展，注入纯模块** —— 新增 `src/access.ts`（access.json 加载/校验/tier 判定/群 allowlist——纯逻辑）与 `src/commands.ts`（命令解析 `parseCommand` + `/help` 文案 + `/status` 渲染——纯函数）；`AgentHandler` 构造注入二者，`onText` 顺序硬约束：**群帧无 chatId 守卫 → access gate → 命令解析分派 → pending-ask 过期/作答 → agent submit**。access gate 先于命令解析（"commands always handled" 限定为**已授权会话**的命令恒处理——陌生人发 `/help` 得到的是拒绝文案，不是命令面）。
理由：transport `on()` 无传播控制（所有 handler 收到全部事件），独立 GateHandler 拦不住 AgentHandler；(c) gateway.ts 是状态面，不该长消息分派。
Codex 强化（采纳）：dispatch 保持薄编排——分派只做路由，具体动作下沉纯模块。

## D2: access.json schema 与热生效

**选定 (a)+强化：四键可选数组 + 逐入站重读 + 分级失败面** —— `{ "admin": [userid...], "approved": [userid...], "rejected": [userid...], "groups": [chatid...] }`；键全部可选、缺省空数组（W1 占位 `{}` 继续合法 = p2p 全拒 + 无群）；值为**字符串数组**（trim 后非空）、**列表内唯一**（重复 ⇒ 损坏）；启动时损坏 ⇒ `ConfigError` 响亮失败（W1 严格配置同构）；运行期逐入站重读（feishubot 同构，热生效），重读失败（IO/非法 JSON/形状不符）⇒ **沿用最近一次有效快照 + ERROR 日志**（fail-visible 不崩消息面——热编辑中途的半成品文件不得打死网关）。
- **tier 优先级：admin > rejected > approved**（approved+rejected 冲突 ⇒ 拒绝优先；admin 显式信任恒放行）。跨列表重叠不报错——优先级即裁决。
- **群授权边界：群流量只看 `groups` allowlist（chatid），不查发送者 approved**（feishubot 同构：非 p2p 直接 deliver）；**rejected 用户在群内 @ 机器人 ⇒ 静默忽略 + warn 日志**（群是共享场，逐条回执刷屏；拒绝文案只在 p2p 发）。
- rejected 与 unknown 同文案（不披露名单状态——"nothing further disclosed"）。
理由：(b) 丢 rejected/groups 两轴；(c) 映射形与数组形无本质差、校验面更繁。
Codex 强化（采纳）：唯一性校验、热重读 fail-safe（last-known-good）、unknown/rejected 同文案。
**FLAGGED-FOR-HUMAN**：群成员资格即授权——allow-listed 群的**任何成员**（含 unknown userid）可用机器人（p2p 仍白名单制）。issue 原文「groups are @-trigger with a chatid allowlist」即此语义，单 owner 部署下群成员由 owner 控制；若需群内也按 userid 白名单，属 v2 收紧。

## D3: @-提及检测（群策略）

**选定 (a)+强化：config `groupMentionName` + 精确 token 边界匹配** —— config.json 新键 `groupMentionName?: string`（trim 后非空字符串，否则 ConfigError）；**`groups` 非空而 `groupMentionName` 缺失 ⇒ 启动 ConfigError**（严格配置：配了群却配不出怎么触发，是配置残缺）；群消息 content trim 后必须以 `@<name>` 开头**且 name 后是空白或串尾**（`@botbot` 不得命中 `@bot`——token 边界）才处理；命中后剥离提及段，余文（可为空 ⇒ 忽略该帧）进入群会话；未命中/无 @ ⇒ 静默忽略 + debug 日志。
理由：(b) 宽松剥离会吞掉 @别人 的消息；(c) 违反 issue「only @-mentions processed」。
Codex 强化（采纳）：token 边界（防前缀误命中）。
**FLAGGED-FOR-HUMAN**：真实平台 @ 载荷语义（mention 文本是否原样内嵌于 `text.content`、名称用 @ 后哪个串）**未经真实平台验证**——SDK 类型无 mention 字段（实测 `.d.ts`），`groupMentionName` 配置钮吸收该不确定性；列入 Human-Review 手工清单（真实群发一条 @ 消息核对 content 形状，必要时改配置即适配）。

## D4: 命令语义与 abort 实现

**选定 (a)+强化：/new /stop 共用 manager.abortChat，终帧即收口** ——
- `manager.abortChat(chatKey): 'stopped' | 'idle'`（新公开方法）：查 `busy.get(chatKey)`；在跑 ⇒ 清 deadline/askDeadline、清该 chat pendingAsks 条目、drop 该 chat 队列、标记新哨兵 `abortedProcs`、SIGINT + `terminateChild` 收割（沿用 `killAskTurn` 的代际检查模式——`turn?.proc === proc` 防误杀换代回合）；无在跑回合 ⇒ 仅 drop 队列，返回 'idle'。EOF 失败路径按哨兵发 `turn_failed`（error=`'turn aborted by user command'`）——**中止流的终帧即 /stop 的 clean stream close**。
- `/stop`：`abortChat` ⇒ 'stopped' 时**不另发 ack**（终帧由 aborted turn 的 turn_failed 映射文案「⏹ 已停止当前回合」收口——单帧）；'idle' 时 notice「当前没有进行中的回合」。**保留会话档**（下一条消息续接）。
- `/new`：`abortChat`（含 pending ask 一并杀）→ `sessions.close(chatKey)` → notice「🔄 已重置会话，下一条消息将开启全新对话」。在跑回合时两帧（中止终帧 + 重置回执）——语义各自成立，可接受。
- handler `userFacingError` 增映射：`turn aborted by user command` → 「⏹ 已停止当前回合」。
- 命令解析：feishubot 同款 `parseCommand`（`/^\/([\w-]+)\s*([\s\S]*)$/`，名字小写化——`/STOP` 同 `/stop`）；**未知命令 ⇒ 帮助文案**（feishubot 同构）。
- 命令不消费 pending ask（/stop 期间有 pending ask ⇒ 中止而非作答——feishubot「commands never claim」同构）。
- EOF 永不到达的兜底：既有收割梯子（stdin.end→2s→SIGTERM→1s→SIGKILL）+ EOF-无终态必报 turn_failed 的 W2 保证——abort 不会留孤儿流。
理由：双帧 ack（独立回执 + 终帧）在流式 UI 上重叠展示是噪音；abort 走既有哨兵机制是最小改动面。
Codex 强化（采纳）：abortChat 必须定向杀 proc（代际检查）、清 pendingAsks、drop 队列、EOF 兜底显式化。

## D5: enter_chat 欢迎与 feedback_event

**选定 (a)+强化：分层欢迎 + 5s 硬路径** —— `enterChat` 事件（仅 single；群 enter_chat 忽略 + debug）：
- tier ∈ {admin, approved} ⇒ `transport.replyWelcome(ref, 欢迎 + 命令清单)`（复用 /help 文案）；
- tier ∈ {rejected, unknown} ⇒ `replyWelcome(ref, 拒绝文案)`（与 S11 同文——明确拒绝、不泄命令面）；
- 5s 硬路径：access.json **同步读**（小文件 readFileSync，事件到达即判）+ 立即调用 replyWelcome，**无任何前置 await**；发送失败（超窗/网络）⇒ ERROR 日志留痕，不影响消息面。
- `feedback_event` ⇒ info 日志（msgid/userid/chatType，**不记内容**）仅此而已。
- welcome **不走 ConversationRateLimiter**（独立 `aibot_respond_welcome_msg` 通道、每用户每天一次——30/min 窗口语义不覆盖此通道；记账反制造假预算）。
理由：(b) 陌生人静默违反 AC4「answers within 5 s」的字面（分层后两类人都有 5s 内应答）；(c) 泄命令面。
Codex 强化（采纳）：5s 路径零 await 前置、失败留痕、群 enter_chat 忽略。

## D6: /status 权限与内容

**选定 (a)+强化：admin 且仅 p2p** —— `/status` 仅 admin 在**单聊**可用；approved 用户（或群内任何人）发 /status ⇒ notice「/status 仅管理员私聊可用」（群内不披露任何 roster——共享场泄露面）。内容：连接态（connected/authenticated——经注入的 state 快照或 transport.isConnected）+ admins + approved + groups 三名单 + 活跃会话数（SessionStore 活动档计数）+ in-flight 回合数（manager.busy 深度）；标注「快照」。
理由：内容披露 admin 名单——管理面信息；feishubot 的 /status 只报任务态不报名单，本 issue 明确要名单，故收紧。
Codex 强化（采纳）：群内 /status 拒答（redacted refusal），名单只进私聊。

## D7: transport 事件面扩展

**选定 (a)：类型化事件 + replyWelcome** —— `TransportEvent` 增 `{ type: 'enterChat'; message: InboundEnterChat }`（{msgid, chatType, chatId?, userId, replyTo}）与 `{ type: 'feedbackEvent'; message: {msgid, userId, chatType, chatId?} }`；`WeComTransport` 增 `replyWelcome(ref: ReplyRef, content: string): Promise<void>`（errcode≠0 拒绝即抛——replyStream 同构）；adapter 订阅 `event.enter_chat` / `event.feedback_event`（其余 `event.*` debug 忽略）；mock 服务端补 `pushEnterChat` / `pushFeedbackEvent`（含 `aibot_respond_welcome_msg` 回执记账，供断言）。
理由：(b) 把生命周期事件塞 textMessage 是类型混淆，会误触 agent 分派。

## D8: 拒绝回执路径

**选定 (a)：逐条回执 + 限流兜底，无内存去重** —— 陌生人/rejected 的 **p2p** 消息逐条经 `notice()` 一次性流回拒绝文案（预算耗尽即丢 + debug 日志）+ info 日志（msgid/userid——**不记内容**）；群内 rejected 静默忽略（D2）。
预算隔离说明（采纳 codex 关切的结构性回应）：ConversationRateLimiter 以 chatKey 记账——陌生人 p2p 的键是 `single:<自己的userid>`，**烧的是自己的会话预算**，与任何授权用户的 chat 预算天然隔离；群预算不进拒绝帧（群内静默）。授权用户的命令 notice 用各自 chat 预算。不存在「陌生人刷屏压制授权用户回执」的共享预算面。
理由：(b) 首次去重需 TTL 策略且错过授权状态变化（刚批准的人仍被哑拒）。
Codex 强化（采纳）：日志不记消息内容；群内静默。

## D9: 命令回执发送路径

**选定 (a)：notice() 语义（非关键）** —— `/help`、`/new`、`/stop`(idle)、未知命令、/status 拒答提示全部走既有 `notice()`（tryAcquire、预算耗尽即丢——丢的是可重发的回执，不是命令执行）；唯一的可靠收口是 /stop 的中止终帧——它走 `send()` 关键路径（有界等待 + 强制逃逸 + 记账，W2 语义），codex 要的「reliable final frame or fallback」即此。
理由：criticalFinal 强制送达面留给真正的关键终态；命令 ack 丢了用户重发即可。

## D10: 群内命令

**选定 (a)：@机器人 + /cmd 在 allow-listed 群内同样分派（/status 除外）** —— 群内 `@bot /new`、`@bot /stop`、`@bot /help` 与群会话管理需求对齐（群回合失控时群内成员能停）；`/status` 恒 admin-p2p-only（D6）。任何 allow-listed 群成员可发（与该成员可 @ 机器人对话同一授权面——群成员资格即授权，D2 FLAGGED 同源）。
理由：(b) 让群会话不可控（回合挂了只有等超时）。
Codex 裁定（采纳）：/status 排除出群命令面；「群控制权属谁」（任何成员 vs admin）列为 FLAGGED（并入 D2 的群授权 FLAGGED）。

## 评审缺失记录

- 无。codex 调用记录：`options` 轮 ×1（verdict: needs-attention，10 项全部方向性同意、强化全部采纳、0 项否决；2 项信息缺口以配置钮 + FLAGGED 吸收——D3 真实 @ 载荷、D2/D10 群授权边界）；`plan` 轮 R1（verdict: needs-attention，7 项 findings 全部采纳修复进 plan.md——见下节）；`plan` 轮 R2（verdict: needs-attention，5 项 findings 全部采纳修复——见 R2 节）；`plan` 轮 R3（verdict: needs-attention，3 项 findings 全部采纳修复——见 R3 节。轮次预算 3 已用尽，R3 修复未再跑第 4 轮复验，残余风险由 Step 3.5 自审清单 + 执行阶段 Checkpoint A–D full gate 兜底）。

## plan 评审 R1 修订（7 项全部采纳）

- **帧内不可变快照（R1-F2）**：`AccessGate` 重构为 `load(): AccessSnapshot`——一次入站帧恰好 load 一次，gate/命令分派//status 名单共用同一版本；热编辑不得撕裂单帧授权（原 tierOf/groupAllowed 各自重读的设计废弃）。
- **abortChat 三态（R1-F4）**：返回 `{status: 'stopped' | 'stopping' | 'idle', dropped}`——双击 /stop 命中收割中回合（'stopping'）不再误报「当前没有进行中的回合」；handler 仅 'idle' 发提示。
- **/status 已声明依赖 + authenticated（R1-F3）**：`WeComTransport` 增 `connectionStatus(): {connected, authenticated}`（adapter 跟踪 authenticated 标志）；statusText 渲染双字段（「已连接（已认证）/已连接（未认证）/未连接」）。
- **W2 测试基线漂移（R1-F1）**：access gate 使既有 agent.test.ts 全部用例（空 access 下 u1 = 陌生人）回归红——setup() 补写 `{approved:['u1']}` 进 access.json，列为 Task 7 显式步骤 + Checkpoint C 全量护栏。
- **/new 在跑编排证据（R1-F5）**：集成测试补——在跑回合 + 排队消息 + /new ⇒ 中止终帧 + 重置回执、排队消息永不再 spawn（argv 恒 1）、旧会话档闭锁（active=0）、下回合 fresh（resumeId=null）。
- **契约测试补全（R1-F6）**：群内 /status 拒答且零 roster 泄露、rejected 与 unknown p2p 同文案且零 spawn、未知命令→帮助文案、pending ask 期间 /stop 中止而非作答（命令先于 ask）。
- **Human-Review 证据门槛（R1-F7）**：Checkpoint D 增四项空栏证据清单（真实 @ 载荷抓样、welcome ≤5s 时间戳、群授权签认、真机拒绝送达）——PR 描述携带，owner 填齐方可合并。

## plan 评审 R2 修订（5 项全部采纳）

- **Access 启动错误契约（R2-F1）**：`AccessGate` 构造的读失败（ENOENT/权限）一律包成 `AccessError`（不再裸泄 fs 错误）；Task 7 补 createGateway 启动面测试——access.json 缺失与损坏均响亮抛错。
- **提交序保绿（R2-F2）**：Task 4 同 commit 迁移 agent-handler 测试的 FakeTransport（接口扩员即时补桩）；Task 6 同 commit 迁移既有 `makeHandler` fixture（access 必填 + 写放行 access.json）——每个任务 commit 自身 typecheck+test 绿。
- **/new 编排测试可完成性（R2-F3）**：no-output 场景永不产出——fresh 回合断言前把 `FAKE_CLAUDE_SCENARIO` 切到 happy（fake claude 每次 spawn 读当前 env），不要求在 no-output 下等终帧。
- **双终局独立等待（R2-F4）**：/new 的重置回执与中止终帧到达次序不定——两条 waitUntil 各自独立等待后再断言，消除伪Flaky。
- **日志契约可验证（R2-F5）**：补日志断言测试——feedback_event 有 info 条目（含 msgid、无内容面）、未授权入站日志不含消息内容、replyWelcome 失败 ERROR 留痕（读 logger JSONL 日文件）。

## plan 评审 R3 修订（3 项全部采纳——轮次预算用尽，未跑第 4 轮复验）

- **AccessError 契约归一（R3-F1）**：`AccessError extends ConfigError`——缺失/不可读/损坏 access.json 的启动失败与 W1/W2 配置错误同契约（统一 instanceof 消费面）；Task 7 测试断言双重 instanceof，SPEC/README 措辞同口径。
- **Task 6 提交序保绿（R3-F2）**：createGateway 接线（AccessGate 注入 + 交叉校验）与 agent.test.ts setup 基线迁移**并入 Task 6 同 commit**——access 必填依赖落地的同时接线上游、迁移下游测试，Task 6 commit 自身 `bun run typecheck && bun test` 全绿；Task 7 重定义为测试固化任务（零实现改动）。
- **welcome 平台拒绝可验证（R3-F3）**：mock 服务端增 `welcomeErrcode` 错误模式（对 aibot_respond_welcome_msg 回非 0 errcode）；transport 测试断言 `replyWelcome` 在平台拒绝时 reject（errcode=40097 样例）——handler 的 ERROR 审计路径有真实契约锚点。

## FLAGGED-FOR-HUMAN 汇总

1. **群成员资格即授权**（D2/D10）：allow-listed 群的任何成员（含 unknown userid）可 @ 机器人使用 / 对群会话发 /new //stop；rejected userid 群内静默忽略。单 owner 部署下群成员由 owner 控制；若需群内按 userid 白名单或命令权限分层，属 v2。
2. **真实平台 @ 载荷语义**（D3）：mention 文本内嵌 `text.content` 的确切形状未经真实平台验证（SDK 类型无 mention 字段）；`groupMentionName` 配置钮吸收不确定性——Human-Review 手工清单：真实群发 @ 消息核对 content，必要时改配置适配。
3. **welcome 真实通道验证**（D5）：`replyWelcome` 5s 窗口与 `enter_chat` 每日一次语义来自 SDK 文档声明，mock 服务端只能验协议形状——列入 Human-Review 手工清单（同 W1/W2 真实平台验证项）。
