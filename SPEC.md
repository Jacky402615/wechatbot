# wechatbot SPEC

WeCom 智能机器人 gateway，长连接模式。镜像 feishubot 的角色：每会话 spawn claude 并流式回传（agent 层为 W2+，本版仅 echo）。

## Transport（W1 契约）

- 连接：`wss://openws.work.weixin.qq.com`。高级/测试：环境变量 `WECOM_WS_URL` 可覆盖连接地址
  （信任假设：进程环境属运维控制面——详见 docs/issues/1/decisions.md D12；README 快速开始不涉及）。
- 认证：`aibot_subscribe`，凭据来自 `<workspace>/.bot/.env` 的 `WECOM_BOT_ID`/`WECOM_SECRET`。
  凭据缺失：启动即失败（非零退出 + JSONL ERROR `startup failed: credentials`）。
  订阅失败（错误凭据/服务端拒绝）：SDK 按 1s/2s/4s/8s/16s 退避重试认证，默认约 30 s 后
  由 transport 启动超时兜底——ERROR 日志 + 进程非零退出（不静默、不空转）。
- 心跳：SDK 内建 ping，默认 30 s（config.json `heartbeatInterval` 可调）。
  实测（soak，mock 服务端）：10 min 存活 19 次心跳，无失联。
- 重连（异常断链，非被踢）：SDK 内建指数退避——基础延迟 1 s、上限 30 s
  （`reconnectInterval` 可压低），默认无限重试（`maxReconnectAttempts: -1`，config.json 可调）。
  实测（soak，reconnectInterval=200 ms）：kill 后 +207 ms 重新 subscribe，+1002 ms 完全恢复，
  恢复后 10 min 内零再次失联。
- 被踢（`disconnected_event`）：有新连接顶替旧连接。SDK 1.0.7 在此路径不自动重连
  （内置 isManualClose），由 adapter 延迟重新订阅自愈：默认 5 s（防与顶替者互踢），
  认证耗尽类致命错误不重试。网关不重启：记录 ERROR 与 kickedCount，恢复后继续应答。
  实测（集成测试，压缩延迟 150 ms）：被踢 → 重订阅 → 新消息自动 echo 成功。
- 单连接约束：一个 bot 同时只有一条活动连接。

## Echo（W1 契约）

- 入站 `aibot_msg_callback` 文本（仅 `chattype === "single"`）：以 `aibot_respond_msg` stream 协议
  回显原文——单帧，`finish=true`，`stream.id` 为 UUID，`req_id` 透传自回调帧。
- W1 只订阅文本回调（SDK `message.text`）；群聊文本：忽略（debug 日志）。

## CLI（W1 契约）

- `wechatbot run|start|stop|status [-r <workspace>]`；`-r` 默认 `$PWD`。
- `.bot/` 布局：`.env`（凭据）、`config.json`（logLevel / heartbeatInterval / maxReconnectAttempts）、
  `access.json`（W3 前为空占位）、`sessions/ uploads/ logs/`、`state.json`（status 数据源）、
  `gateway.pid`（守护 pidfile，JSON：pid + /proc starttime 防 pid 复用）。
- 日志：`.bot/logs/gateway-YYYYMMDD.jsonl`，JSONL，按日切分，保留 14 天。
- `status`：pid 存活且归属匹配时输出完整状态 JSON；pid 已死时把 running/connected 归一为
  false 并标 `stale: true`（无僵尸 connected）；state 损坏时显式报 `state corrupt`（退出 1）。
- 退出码：0 正常；1 运行期失败（凭据/订阅/启动即死）；2 用法错误。
