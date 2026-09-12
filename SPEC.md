# wechatbot SPEC

WeCom 智能机器人 gateway，长连接模式。镜像 feishubot 的角色：每会话 spawn claude 并流式回传。

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

## Agent 会话层（W2 契约）

- 会话：每 chat 一个 claude 会话（单聊 `single:<userid>`、群聊 `group:<chatid>`——群帧缺
  `chatid` 即忽略）；`.bot/sessions/<base64url(chatKey)>.json`（原子写 0600，键长 ≤160 UTF-8
  字节——含原子写 tmp 后缀的文件名预算）；惰性 TTL：入站时 `session_idle_ttl_minutes`
  （默认 60）内 resume 同 `claudeSessionId`，过期闭旧建新。
- spawn：`claude --print --output-format stream-json --input-format stream-json --verbose
  --permission-prompt-tool stdio --permission-mode bypassPermissions --append-system-prompt <sys>
  --model <claudeModel>`（缺省 glm-5.3-flash），cwd=工作区，env 无 `CLAUDECODE`；每回合独立
  子进程，回合结束走收割梯子（stdin.end→2s→SIGTERM→1s→SIGKILL——claude --print 等 stdin
  EOF）。入站消息带前导 `[Context: sender=<userid>, userid=<userid>, chat=<chat> (p2p|group)]`。
- 流桥：回合输出经 `aibot_respond_msg` 流式回传——`stream.id` 回合内恒定、刷新帧携带全量
  内容（≥2s 节流）、终帧 `finish=true`；内容上限 20000 字节（SDK 20480），按字节安全截断。
  实测（集成测试，mock 服务端 + fake claude）：多帧刷新同 id、终帧收尾。
- 平台护栏：会话级 30 msg/min 与 1000/h 双窗限流，覆盖全部出站帧——刷新/通知帧预算耗尽
  即丢（刷新幂等、通知非关键）；终帧有界等待预算（≤25 s）后强制发送并**逃逸记账**
  （record 进双窗 + ERROR 日志——超限可见，孤儿流比静默超限更糟）；每用户 ≤3 in-flight
  （按运行回合单计，跨会话；群批量回合按排队发送者全体计、群内作答者追加计入）；全局
  `maxConcurrentTurns`（默认 4，资源帽）；每 chat 队列上限 20（溢出回执「队列已满」）。
- 超时：按**流段**计——spawn→本段终局（ask 闭流或回合终态）默认 570 s（平台 10 min −
  30 s 边距）；ask 等待期不计时（进程寿命由会话 TTL 惰性约束 + 关停收割兜底）；作答后
  续段重获整段预算。到点终帧「⏱ 回合超时」+ SIGINT 收割（无视信号的子进程由收割梯子
  升级 SIGKILL，全程有界）。实测（压缩注入）：无输出回合、晚输出回合、无视信号子进程
  均按期收流不悬挂。
- 排队：回合进行中同 chat 消息入队（上限 20），回合结束按序合为一个批量回合（多条时带
  【消息 N】框架提示）；槽位释放后先 drain 本 chat、再跨 chat FIFO 提升其他排队者。
- AskUserQuestion 文本回退：ask 到达即闭流（已产出文本 + 扁平编号清单——跨题连续编号，
  multiSelect 注记）；数字回复（`1` / `1,3`，全角逗号/顿号容忍）确定性映射回
  `control_response`（跨题混合选择合法；部分作答允许——缺键即未作答，agent 补问）；非数字
  文本作为首题自由答案；越界/单选题多项提示重试（一次性通知流，预算耗尽即丢）；pending
  ask 随会话 TTL 过期（杀进程 + 新会话提示）。群内任何成员可作答（v1）。实测：编号渲染、
  单选/多选/跨题作答、无效重试、续流新 stream 均覆盖。
- 失败面：回合失败终帧通用文案（细节入日志）+ `state.json` lastError；spawn 失败明确回执
  「claude 不可用」；EOF 无终态（含 exit 0）必报失败不留孤儿流；resume「No conversation
  found」自动 fresh 重试恰好一次。实测：crash/garbage/超时路径均收流。
- 权限姿态：`--permission-mode bypassPermissions` 镜像 feishubot 生产（FLAGGED：收紧另立
  issue；system prompt 的工作区边界是行为引导，非安全边界）。

## CLI（W1 契约）

- `wechatbot run|start|stop|status [-r <workspace>]`；`-r` 默认 `$PWD`。
- `.bot/` 布局：`.env`（凭据，权限 0600——创建即收紧，宽松会被修复）、
  `config.json`（logLevel / heartbeatInterval / maxReconnectAttempts /
  `session_idle_ttl_minutes` / claudeModel / maxConcurrentTurns——数字键必须整数且 > 0
  （重连次数 -1 或 ≥ 0），claudeModel 为 trim 后非空字符串，非法值启动即拒；agent 三键
  缺省不填，默认值由 agent 层持有——TTL 60 分钟、模型 glm-5.3-flash、并发帽 4）、
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
