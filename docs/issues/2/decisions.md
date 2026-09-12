# decisions.md — issue 2（Agent session layer: spawn claude、per-chat 会话 + TTL resume、stream bridge、AskUser 文本回退）

- 日期：2026-09-13（r1，self-grill + codex-eval `kind=options` 一轮）
- 评审结论：`needs-attention`（12 项裁定全部方向性同意，其中 5 项附实质强化，全部采纳）
- 依据：issue 描述（内嵌 SRS 节）+ feishubot 生产源码实测（`/home/ubuntu/wiki-symphony-ws/projects/feishubot`，agent 层 manager/parser/session/ask-parse）+ `@wecom/aibot-node-sdk@1.0.7` `.d.ts` 实测 + W1 代码勘察

## D1: Agent 层模块划分

**选定 (a)：镜像 feishubot 的简化四模块** —— `src/agent/parser.ts`（纯函数：stream-json 行解析、ask 提取、数字回复解析）、`src/agent/session-store.ts`（每 chat 会话 JSON + TTL）、`src/agent/manager.ts`（spawn/busy/队列/收割梯子/pending ask；**transport 无关**——注入 `claudeCommand`/时钟/事件回调）、`src/handlers/agent.ts`（transport↔manager 接线 + WeCom 流桥：streamId、节流、限流、字节上限、超时护栏、ask 渲染全部收在此处）；Gateway 把 `EchoHandler` 换成 `AgentHandler`。
理由：解析/进程生命周期/排队/流桥四轴分离各自可测；(b) 单文件把四轴耦合成 AC3–AC5 的测试障碍；(c) `@anthropic-ai/claude-agent-sdk` 引入未验证依赖且与已实测的 CLI 协议漂移。
Codex 强化（采纳）：manager 保持 transport 无关（注入 command/clock/回调）；streamId/节流/限流/字节/超时**只**出现在 AgentHandler——manager 不得变成第二个 Gateway。

## D2: 群聊处理范围

**选定 (a)：transport 补解析 `chatid`，群聊进 agent 层** —— `InboundTextMessage` 增加 `chatId`（SDK `.d.ts` 实测：`chatid?` 仅群聊返回）；会话键 `single:<userid>` / `group:<chatid>`；群消息要求 `chatid` 在场（缺失 ⇒ warn + 忽略该帧）；mock 服务端补群帧集成测试；AC1–AC5 仍在单聊上验证。
理由：issue 明言 per-group 会话；W1 的"忽略群聊"只是 echo 时代的占位。(b) 让群聊行为在 SRS 已定范围内继续未定义；(c) @-提及过滤依赖未验证的平台载荷语义，超出 W2。
Codex 附注（采纳）：群聊里的 pending ask **任何群成员都可作答**（回复路由按会话键，不校验发送者——feishubot 生产同构；上下文前缀仍逐条标注真实 sender，agent 可自行判断）。FLAGGED-FOR-HUMAN：群 ask 的「仅发起人可答」约束若产品上有要求，属 v2 收紧项。

## D3: claude 调用形态

**选定 (a)：feishubot 生产参数集 verbatim** —— `claude --print --output-format stream-json --input-format stream-json --verbose --permission-prompt-tool stdio --permission-mode bypassPermissions --append-system-prompt <sys> [--resume <sid>] --model <cfg>`；cwd=workspace；env 去 `CLAUDECODE`；stdio 全管道；spawn 目标取 PATH 上的 `claude`（**不做** win32 shim 解析——W1 已裁定本网关仅支持 Linux）。system prompt = 工作区边界提示 + `.bot/` 布局（wechatbot 版），**明确这不构成安全边界**，只是行为引导。
理由：与 feishubot 生产逐字同构 = 协议已被生产验证；(b) 裁掉 `--permission-prompt-tool stdio` 会破坏 control_request 通路（AskUser 回退依赖它）；(c) 同 D1。
Codex 风险指出（采纳记录）：`bypassPermissions` 下 agent 可越出 cwd——信任模型与 feishubot 生产一致（Sam 的专用 bot 工作区，同机同信任域）。**FLAGGED-FOR-HUMAN**：W2 交付的权限姿态即生产姿态，若需收紧（工具白名单/沙箱）另立 issue。

## D4: 会话存储与 TTL 语义

**选定 (a)：`.bot/sessions/` 落盘 + 惰性 TTL** —— 每 chat 一个 JSON（原子 tmp+rename，**0600 权限**）；文件名 = `base64url(chatKey)`（**不做字符集假设**——codex：WeCom id 字符域未验证）；chatKey = `single:<userid>` / `group:<chatid>`（键本身进 JSON 内容，文件名只是编码）；字段 `{claudeSessionId, chatType, createdAt, lastActiveAt, status}`；入站时惰性检查 `isStale(ttl)` ⇒ 过期即闭旧档新建；活动时间在入站/作答/回合事件时刷新；**无启动清扫**（记录极小、单写者——W1 pidfile 已保证单网关）。
理由：(b) 重启丢 resume；(c) 孤儿清理/留存策略对 W2 是无消费者的仪式感。
Codex 强化（采纳）：0600、base64url 文件名、单写者文档化（W1 单网关契约即单写者证明）。

## D5: 流桥刷新与字节上限

**选定 (a)+强化：全量刷新 + 2s 节流 + 会话级限流预算 + 字节安全截断** —— assistant 文本累积全文；距上帧 ≥2000ms 才发刷新帧（内容为全量快照，刷新帧幂等）；终帧恒发（finish=true，全量）；**会话级限流器覆盖所有出站帧**：30 msg/min 与 1000/h 双窗口（平台护栏「reply+proactive 合并」的忠实编码）——刷新帧在预算耗尽时**丢弃**（无损：下帧仍全量），**终帧旁路限流恒发**（孤儿流比超限更糟，超出部分只可能是终帧）；截断用 `Buffer.byteLength` 按字节计算并预留截断标记空间、不切断 UTF-8 序列（SDK 硬限 20480 字节，内控 20000 + "…[截断]" 标记）。
理由：(b) 无节流即触 30/min；(c) 不满足 AC1 流式。
Codex 强化（采纳，material）：2s/stream 节流证不出**跨帧/跨回合/错误提示/ask 渲染**合计的 30/min 滚动界——补会话级预算；字符截断会切代理对/超字节——改字节级。

## D6: 10 分钟流超时硬护栏

**选定 (a)+关键修正：绝对时限自回合起点（spawn）武装，而非首帧** —— 管理器在 spawn 即起绝对 deadline（默认 570s，预留 30s 安全边距；测试可注入压缩）；到期未终局：发送有界终帧「⏱ 回合超时（10 分钟）已截断」+ finish=true（旁路限流），SIGINT 子进程（收割梯子：stdin.end→EOF 宽限→SIGTERM→SIGKILL），回合按失败记账、队列照常 drain；终态事件到达即取消计时器。
理由：(b) 与平台截断竞速；(c) 违反 AC5。
Codex 关键修正（采纳，material）：首帧武装在**无输出回合**上永不触发——no-output 挂死恰是 AC5 要防的形态；deadline 必须自进程起点算。测试覆盖：无输出、晚输出、无视信号的子进程三态。

## D7: AskUserQuestion 文本回退交互流

**选定 (a)+强化：闭流-新流生命周期 + pending ask 结构化状态** —— ask 到达（control_request subtype=can_use_tool tool_name=AskUserQuestion）：当前流以「已产出文本 + 问题渲染」finish=true **收尾**（渲染：扁平编号跨所有题——Q1 选项 1..n、Q2 选项 n+1..m，multiSelect 标注；字节预算内）；**pending ask 落结构化状态**（tool_use_id/request_id + 问题 schema 持久于管理器，随进程死亡/超时/关停清除）；数字回复（`1` / `1,3`，空白容忍）→ 按扁平编号**确定性分配**到所属题 → 校验每题 multiSelect 约束（单选题多项 ⇒ 无效提示并保持 pending）→ `control_response` 写回**仍在运行**的 claude 进程（`updatedInput.answers:{question: label(, label)}`）；答复后输出开**新流**（新 streamId）。非数字文本 ⇒ 作为首题自由文本答案（feishubot 生产同构）；全数字但越界 ⇒ 流内提示「无效选项，请回复数字」并保持 pending；pending ask 随会话 TTL 过期（过期入站 ⇒ 杀进程 + 通知 ask 已过期 + 起新会话，**不**把裸数字喂给新会话）。
理由：(b) 等答复期间流开着重叠 10 分钟超时（用户思考可超时）；(c) 多题 ask 是 AskUserQuestion 原生能力，砍掉即假支持。
Codex 附注裁定：codex 建议「拒绝跨题混合选择」——**否决**：扁平编号下 `1,3` 跨题分配是确定性的、无歧义（歧义只在单选题多项时出现，已被 multiSelect 校验拦截）；记录分歧。群 ask 作答权见 D2。

## D8: 排队与并发

**选定 (a)+强化：每 chat 串行队列 + 每用户 3 并发信号量 + 全局资源帽** —— 每 chat busy 标志 + FIFO 队列（**上限 20 条**，溢出回执「队列已满」）；忙时入队，回合结束 drain 为一个批量回合（feishubot 式框架提示语）；**每用户 in-flight 信号量 ≤3**（运行中回合 + ask 等待中均计数，跨其全部会话——平台「每用户每 bot 3 并发交互」的直接编码；超出者在各自 chat 队列等待）；全局 `maxConcurrentTurns`（config，默认 4）做资源帽，与平台帽分立。
理由：(c) 违反 AC3；(b) 单用户跨 单聊+群聊 可超平台 3 并发；codex：纯全局帽 3 对无关用户过紧、配大了又不再编码平台帽——三件套各司其职。
Codex 强化（采纳，material）：每用户信号量 = 平台帽的忠实编码；队列上限有界；drain 前重验 TTL（过期即新会话）。

## D9: 模型配置

**选定 (a)：config.json `claudeModel?: string`** —— 键缺省 ⇒ 'glm-5.3-flash'（feishubot 生产同款）；**在场值必须 trim 后非空字符串，否则 ConfigError**（codex：空串回退缺省削弱严格配置语义——比原推荐更严，采纳）；恒传 `--model`；非字符串 ⇒ ConfigError（W1 严格配置同构）。
理由：(b) 行为随机器漂移；(c) 绕开 config 校验面。
FLAGGED-FOR-HUMAN：模型标识被目标 claude 部署接受的最终验证列入 Human-Review 手工清单（CI 无真实 API）。

## D10: 测试策略

**选定 (a)：fake claude 脚本 + mock WeCom 双桩** —— fake claude 为 node 可执行 helper，经 manager 选项 `claudeCommand` 注入（测试传 `{command: process.execPath, argsPrefix:[helper.js]}`）；helper 断言 argv（--resume 在场性、--model）、cwd、env（无 CLAUDECODE）、stdin 收到的 user JSON，按脚本回放 NDJSON（system session_id / assistant 文本 / control_request ask / result / error / 坏行）；单测 parser/session-store/config/manager；集成 = mock 服务端 + fake claude 覆盖 AC1–AC5（TTL/超时/节流全部注入压缩值）。
Codex 强化（采纳）：对抗面清单——argv/cwd/env/stdin JSON/resume 重试/control_response 形状/队列顺序/无输出超时/畸形与截断 NDJSON/stderr+非零退出/急速事件风暴/UTF-8 边界/收割行为；真实 WeCom 流为刷新语义 + 真实 claude resume ⇒ **Human-Review 手工清单**（同 W1 D5 模式）。
理由：(b) mock 掉子进程就测不出 argv/stdio/resume/收割/control_response 的真实缺陷；(c) CI 无凭据不可行。

## D11: EchoHandler 去留

**选定 (a)：删除** —— `src/handlers/echo.ts` 及其专属测试一并删除，相关集成测试针对 AgentHandler + fake claude 重写；transport 级测试（transport.test.ts 等）不动，transport 覆盖保持显式。
理由：(b) echo/config 双模式增加无消费者的测试矩阵；(c) 留死代码。git 历史即归档。

## D12: 关停与失败面

**选定 (a)：有界关停 + 响亮失败 + resume 单次重试** —— `Gateway.stop()` awaits `manager.closeAll()`（SIGINT 全部子进程 + 统一收割梯子 + 清队列/计时器/pending ask，**硬时限兜底**）；回合失败 ⇒ 流内**通用**错误文案 + finish=true（细节进日志，不外泄内部错误），onReplyError → Gateway lastError（W1 同构）；spawn ENOENT ⇒ 明确回执「claude 未安装」；resume「No conversation found」⇒ 提示 + **恰好一次**自动 fresh 重试（feishubot 生产同构）。
理由：(b) 用户面对静默挂起；(c) 可恢复的会话缺失变成永久失败。
Codex 强化（采纳）：closeAll 有界、终帧走同一限流旁路策略、用户可见错误通用化。

## 评审缺失记录

- 无。codex 调用记录：`options` 轮 ×1（verdict: needs-attention，12 项全部方向性同意、5 项 material 强化全部采纳、1 项建议否决并记录分歧——D7 跨题混合选择）；`plan` 轮 R1（verdict: needs-attention，12 项 findings——F1 跨 chat 调度饿死、F2 全局 deadline 互踩、F3 EOF-无终态/ENOENT 无失败事件、F4 过期 ask 先答后判、F5 作答后陈旧 replyTo、F6 终帧旁路破坏限流、F7 ask 渲染被截/顿号不一致、F8 onReplyError 未接线、F9 终态无背压、F10 槽位先于收割释放、F11 AC3 断言与实现矛盾、F12 base64url 文件名超 NAME_MAX——全部采纳修复进 plan.md）；`plan` 轮 R2（verdict: needs-attention，9 项 findings——R2-F1 逃逸不记账/通知不应等待、R2-F2 超时语义需显式化、R2-F3 过期 ask 槽位先于收割释放、R2-F4 通知流破坏活动流状态、R2-F5 接线测试不可通过、R2-F6 AC3 断言仍弱、R2-F7 键长按字符而非字节、R2-F8 群批量回合并发归因、R2-F9 多选缺端到端——全部采纳修复进 plan.md）；`plan` 轮 R3（verdict: needs-attention，5 项 findings——R3-F1 限流契约缺 record()/确定性覆盖、R3-F2 群内作答者漏计并发帽、R3-F3 过期 ask 测试证不出非重叠、R3-F4 晚输出竞态无测试、R3-F5 SPEC 文本与修订语义矛盾——全部采纳修复。轮次预算 3 已用尽，R3 修复未再跑第 4 轮复验，残余风险由 Step 3.5 自审清单 + 执行阶段 Checkpoint A/B/C full gate 兜底）。

## plan 评审 R1 修订（decisions 层面的三处增补）

- **D5 修订（F6）**：终帧不再无条件旁路限流——改为有界等待预算（1s 间隔重试、≤25 次，落在平台 10min 的 30s 安全边距内），到顶才直接发送（孤儿流仍比超限更糟，但正常路径下 30/min 与 1000/h 对**所有**出站帧生效）。通知类帧（队列满/无效选项提示）同样过限流，预算耗尽即丢（非关键）。
- **D7 增补（F7）**：部分作答**允许**（`3` 只答 Q2——AskUserQuestion 缺键＝未作答，agent 补问；feishubot 生产同构）。codex 建议拒绝部分作答（confidence 0.93）——**否决并记录分歧**：扁平编号下部分作答确定且合法，砍掉反而制造"必须全答"的假约束。ask 渲染保底字节预算：已产出文本先截，问题清单拿独立余量（长输出不得截掉编号清单——AC4）。顿号 `、` 纳入数字分隔符（与全角逗号一致）。
- **D8 增补（F1/F5）**：跨 chat 调度——槽位释放后先 drain 本 chat 队列、再跨 chat FIFO 提升其他排队者（否则因全局/用户帽排队的 chat 会饿死）；每用户 in-flight 按"运行回合"单计（ask 等待期进程仍在 busy——不重复计数）。批量回合的回执绑**最新**排队消息的回调（WeCom 回执句柄以最新回调最可能仍有效；与 feishubot F1「首条上下文」相反，属平台差异的显式选择——PR 描述须提及）。
- **D12 增补（F3/F8/F9/F10）**：EOF 无终态必报 turn_failed（exit 0 也不留孤儿流）；spawn ENOENT 单独可识别（handler 映射「claude 不可用」）；manager 对终态事件 `await` 回调（终帧落定才放行下一回合——AC3 进程侧保证）且**收割完成后**才释放槽位；`createGateway` 经 `Gateway.recordAgentError` 把 agent 失败接进 `state.json` lastError。

## plan 评审 R2 修订（4 处增补）

- **D5 再修订（R2-F1）**：逃逸帧**强制记账**（`limiter.record()` 进双窗 + ERROR 日志）——超限可见、账面不撒谎；通知类帧改为"预算耗尽即丢"（不再等待/逃逸——非关键）；补 30/min 与 1000/h 的确定性单测进 plan。
- **D6 措辞修正（R2-F2）**：超时预算按**流段**（stream segment）计，非全进程绝对时限——spawn→本段终局默认 570s；ask 闭流等待期无 deadline（进程寿命由会话 TTL 惰性约束 + closeAll 兜底）；作答后续段重获整段预算（对应平台"每流 10 分钟"语义）。补对抗测试：无视信号的子进程（收割梯子升级 SIGKILL）、晚输出。
- **D8 再增补（R2-F3/F8）**：过期 ask 的槽位保留至收割完成（`terminating` 标记——紧随的新 submit 排队而非并行 spawn）；群聊批量回合的并发帽按**全部发送者**计（`BusyTurn.initiators` 数组）。
- **D7 再增补（R2-F4）**：通知帧（队列满/无效选项提示）走一次性 ephemeral 流，**不触碰活动流状态**（替换会孤儿化运行中回合的流）；ask 续流在每次有效作答后刷新 ref（绑作答回调）。

## FLAGGED-FOR-HUMAN 汇总

1. **权限姿态**（D3）：`bypassPermissions` 镜像 feishubot 生产；若需收紧另立 issue，W2 按生产姿态交付。
2. **群 ask 作答权**（D2/D7）：任何群成员可答（feishubot 同构）；「仅发起人可答」若需要属 v2。
3. **真实平台验证**（D5/D9/D10）：WeCom 真实流刷新语义（同 stream.id 替换行为）、glm-5.3-flash 被目标部署接受、真实 claude resume 上下文保持——均需真实凭据/API，列入 Human-Review 手工清单。
