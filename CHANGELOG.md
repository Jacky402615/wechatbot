# Changelog

## [Unreleased]

### Added
- WeCom 长连接 transport：基于 `@wecom/aibot-node-sdk`（钉死 1.0.7）的自有 adapter——connect、`aibot_subscribe` 认证、30 s 心跳、异常断链指数退避重连、被踢（`disconnected_event`）延迟重订阅自愈；换 SDK 只动 adapter。
- CLI `wechatbot run|start|stop|status [-r <workspace>]`：前台运行、pidfile 守护起停（SIGTERM 优雅 → SIGKILL 兜底、`/proc` starttime 防 pid 复用）、`status` 报告连接状态并对陈旧状态归一。
- 单聊文本 echo：`aibot_respond_msg` stream 协议单帧回显原文，`finish=true`，`req_id` 透传。
- `.bot/` 工作区布局（`.env` 凭据、`config.json`、`access.json` 占位、`sessions/ uploads/ logs/`、原子 `state.json`、`gateway.pid`）。
- 结构化 JSONL 日志（按日切分、保留 14 天）。
- 测试面：mock WeCom WS 服务端集成测试（真实 SDK 走本地帧协议）+ 10 分钟 soak + dist 洁净门（无机器路径、SDK external、双运行时冒烟）+ CI 与 GitHub Packages 发布工作流。
- 行为契约 `SPEC.md`（transport/echo/CLI 节，重连细节以实测数据为准）。

### Fixed
- （无——首个功能版本）

### Changed
- （无）
