# Changelog

## [Unreleased]

### Added
- WeCom 长连接 transport：基于 `@wecom/aibot-node-sdk`（钉死 1.0.7）的自有 adapter——connect、`aibot_subscribe` 认证、30 s 心跳、异常断链指数退避重连、被踢（`disconnected_event`）延迟重订阅自愈；换 SDK 只动 adapter；群聊帧解析 `chatid`（缺失即忽略）。
- Agent 会话层（W2）：每 chat（单聊 per-user / 群聊 per-group）spawn `claude`（`--print` stream-json 双向协议、`bypassPermissions`、`--model` 可配），空闲 TTL 内 `--resume` 续接、过期新建（`.bot/sessions/` 原子落盘 0600）；回合结束有界收割梯子（stdin.end→SIGTERM→SIGKILL）。
- 流式回传：agent 输出经 `aibot_respond_msg` 流协议——`stream.id` 恒定、≥2s 节流全量刷新、终帧 `finish=true`、20 KB 字节安全截断；会话级 30 msg/min 与 1000/h 双窗限流（终帧有界等待 + 逃逸记账）；按流段 570 s 超时硬护栏（ask 等待不计时，作答后新流新预算）。
- 排队与并发：每 chat 串行队列（上限 20，批量回合）、跨 chat FIFO 提升、每用户 ≤3 in-flight（平台护栏，群批量按排队发送者全体计）、全局 `maxConcurrentTurns`（默认 4）。
- AskUserQuestion 文本回退：扁平编号清单闭流渲染；数字回复（`1` / `1,3`，全角逗号/顿号容忍）确定性映射回 `control_response`（跨题分配、部分作答合法）；非数字即首题自由文本；越界提示重试；pending ask 随会话 TTL 过期。
- CLI `wechatbot run|start|stop|status [-r <workspace>]`：前台运行、pidfile 守护起停（SIGTERM 优雅 → SIGKILL 兜底、`/proc` starttime 防 pid 复用）、`status` 报告连接状态并对陈旧状态归一。
- `.bot/` 工作区布局（`.env` 凭据、`config.json`、`access.json` 占位、`sessions/ uploads/ logs/`、原子 `state.json`、`gateway.pid`）。
- 配置键 `session_idle_ttl_minutes` / `claudeModel` / `maxConcurrentTurns`（严格校验，缺省由 agent 层持有默认 60 / glm-5.3-flash / 4）。
- 结构化 JSONL 日志（按日切分、保留 14 天）。
- 测试面：mock WeCom WS 服务端 + fake claude 双桩（场景化 stream-json 回放）——AC1–AC5 全链路集成测试、10 分钟 soak、dist 洁净门（无机器路径、SDK external、双运行时冒烟）+ CI 与 GitHub Packages 发布工作流。
- 命令与访问面（W3）：网关命令 `/new`（中止+重置会话）/`/stop`（中止在跑回合，中止终帧即收流）/`/status`（仅管理员私聊）/`/help`——命令先于 agent 路径解析，永不进会话；`access.json` 三层访问控制（admin/approved/rejected by userid + groups allowlist by chatid，帧内单快照防撕裂，逐帧热重读 last-known-good）；群策略 = allowlist 内 @-提及触发（`groupMentionName` token 边界匹配剥离）；`enter_chat` 5 s 内分层欢迎（allowed→欢迎+命令清单，其余→拒绝文案）；`feedback_event` 仅日志；config 新键 `groupMentionName`。
- 附件面（W4）：单聊 image/file/voice/video 经 SDK 内建 `downloadFile`（AES-256-CBC per-link aeskey 解密）过 access gate 后立即下载落盘 `.bot/uploads/YYYY-MM-DD/`（`<safeMsgid>-` 消毒名，msgid/文件名白名单+注入防线；30 天启动+每日剪枝，仅删真实日期目录）；prompt 携带绝对路径（image/file 附 Read 提示；voice/video 显式声明归档不可解析——转写 v2+）；缺 url/aeskey、过期 URL、解密失败 ⇒ 关键终帧站内短错误（不 spawn）；空/超 100 MB/落盘失败降级 note 回合照跑——任何路径不静默丢；群媒体帧与 mixed（群图文，显式订阅 + debug 留痕零事件）可见忽略（known gap，follow-up #8）；msgid 有损消毒追加短哈希后缀防跨消息折叠；prune 只删真实日期目录（文件/软链/无效日历不动）。
- 行为契约 `SPEC.md`（transport/agent 会话层/CLI/命令与访问面节，行为以实测数据为准）。

### Fixed
- （无——首个功能版本）

### Changed
- （无）
