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
- 重连（异常断链，非被踢）：SDK 内建退避重连——指数退避与 1 s 基础延迟 / 30 s 上限
  **来自 SDK 1.0.7 源码声明**（本仓测试实测到单点重连时延，未断言完整指数序列），
  默认无限重试（`maxReconnectAttempts: -1`，config.json 可调）。
  实测（soak，reconnectInterval=200 ms）：kill 后 +207 ms 重新 subscribe，+1002 ms 完全恢复，
  恢复后 10 min 内零再次失联。
- 被踢（`disconnected_event`）：有新连接顶替旧连接。SDK 1.0.7 在此路径不自动重连
  （内置 isManualClose），由 adapter 延迟重新订阅自愈：默认 5 s（防与顶替者互踢），
  认证耗尽类致命错误不重试（直接命中或 wrapped cause 均识别），并上报 **fatal**——
  宿主进程优雅停机并以退出码 1 结束（不空转）。网关不重启：记录 ERROR
  与 kickedCount，恢复后继续应答。
  实测（集成测试，压缩延迟 150 ms）：被踢 → 重订阅 → 新消息自动 echo 成功。
- 单连接约束：一个 bot 同时只有一条活动连接。

## Echo（W1 契约）

- 入站 `aibot_msg_callback` 文本（仅 `chattype === "single"`）：以 `aibot_respond_msg` stream 协议
  回显原文——单帧，`finish=true`，`stream.id` 为 UUID，`req_id` 透传自回调帧。
- W1 只订阅文本回调（SDK `message.text`）；群聊文本：忽略（debug 日志）。

## CLI（W1 契约）

- `wechatbot run|start|stop|status [-r <workspace>]`；`-r` 默认 `$PWD`。
- `.bot/` 布局：`.env`（凭据，权限 0600——创建即收紧，宽松会被修复）、
  `config.json`（logLevel / heartbeatInterval / maxReconnectAttempts——后两者必须整数，
  心跳 > 0，重连次数 -1 或 ≥ 0，非法值启动即拒）、
  `access.json`（W3 前为空占位）、`sessions/ uploads/ logs/`、`state.json`（status 数据源）、
  `gateway.pid`（pidfile，JSON：pid + /proc starttime 防 pid 复用；**前台 run 与后台 start 都持有**，
  退出时清理）。
- pid 归属：仅当 pid 存活**且** starttime 匹配才认定为我们的网关；记录缺失/不匹配一律拒绝
  （status 报陈旧、stop 不发信号——宁可误报未运行，不误杀无关进程）。pidfile 记录无法读取
  /proc starttime 的平台（非 Linux）上 run/start 直接失败——守护归属校验是硬要求。
- `start` 语义：轮询至"**认证确认**（state.authenticated，而非仅 socket connected）/ 子进程退出 /
  45 s 超时"才返回——返回 0 即订阅已被服务端确认；失败/超时杀子进程、清 pidfile、返回 1。
- `status` 兼做首启初始化：幂等创建 `.bot/` 树（config 损坏不阻塞状态报告，初始化失败仅告警）。
- `stop`/`status` 为管理面：不解析 config/.env——config 损坏也能停掉/报告在跑的网关；
  pidfile 存在但无法解析时拒绝破坏性清理（退出 1，留人工处置）。
- 日志：`.bot/logs/gateway-YYYYMMDD.jsonl`，JSONL，按日切分，保留 14 天。
  写失败/清理失败：stderr 留痕，不中断消息面。
- `status`：pid 存活且归属匹配时输出完整状态 JSON；pid 已死时把 running/connected 归一为
  false 并标 `stale: true`（无僵尸 connected）；state 损坏时显式报 `state corrupt`（退出 1）。
- 退出码：0 正常；1 运行期失败（凭据/订阅/启动即死/优雅关闭失败）；2 用法错误。
