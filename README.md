# wechatbot

WeCom（企业微信）智能机器人 gateway——长连接模式。每 chat（单聊 per-user / 群聊 per-group）
一个 `claude` 会话：空闲 TTL 内 `--resume` 续接、流式回传（`finish=true` 收尾）、
AskUserQuestion 降级为编号文本 + 数字回复。完整行为契约见 [SPEC.md](./SPEC.md)。

## 安装

包发布在 GitHub Packages（scope 需与仓库 owner 一致）：

```ini
# .npmrc
@jacky402615:registry=https://npm.pkg.github.com
```

```sh
npm install @jacky402615/wechatbot
```

要求：Node ≥ 22 或 Bun ≥ 1.3（dist 双运行时可执行）；**运行网关（`run`/`start`）需要 Linux**——
pidfile 归属校验依赖 `/proc/<pid>/stat`，不可校验的平台会拒绝启动（`status`/`stop` 等管理命令不受限）。

## 快速开始

```sh
# 1. 初始化工作区（首启自动创建 .bot/ 目录树与模板）
wechatbot status -r /path/to/workspace

# 2. 填入凭据（企业微信智能机器人后台获取）
$EDITOR /path/to/workspace/.bot/.env
#   WECOM_BOT_ID=xxx
#   WECOM_SECRET=yyy

# 3. 后台启动并查看连接状态
wechatbot start -r /path/to/workspace
wechatbot status -r /path/to/workspace

# 停止
wechatbot stop -r /path/to/workspace
```

前台调试用 `wechatbot run -r <workspace>`。日志在 `<workspace>/.bot/logs/`（JSONL，按日切分）。

### 访问控制（`.bot/access.json`）

```json
{ "admin": ["你的userid"], "approved": ["同事userid"], "rejected": [], "groups": ["群chatid"] }
```

私聊仅 admin/approved 应答（其余得到拒绝提示）；群聊仅 allowlist 内的 @ 提及应答
（需同时在 `config.json` 配 `groupMentionName`）。改动即时生效（逐消息重读）。
可用命令：`/new` `/stop` `/status`（仅管理员私聊）`/help`。

### 附件（图片 / 文件 / 语音 / 视频）

私聊发送的图片与文件会被机器人下载解密并保存到 `<workspace>/.bot/uploads/YYYY-MM-DD/`，
随后交给 claude 处理（可直接查看图片与文件内容）。语音与视频仅归档——当前版本无法解析
其内容（转写属后续版本）。附件下载失败（如链接过期）会收到一条失败提示。文件保留 30 天
后自动清理。群聊内的图片消息（图文混排）当前版本暂不支持。

### 配置（`<workspace>/.bot/config.json`）

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `logLevel` | `debug\|info\|warn\|error` | `info` | 日志级别 |
| `heartbeatInterval` | 整数 >0 | SDK 默认（30s） | WS 心跳间隔（ms） |
| `maxReconnectAttempts` | -1 或 ≥0 | -1（无限） | 断链重连次数上限 |
| `session_idle_ttl_minutes` | 整数 >0 | 60 | 会话空闲 TTL（分钟）——期内 `--resume` 续接，过期新会话 |
| `claudeModel` | 非空字符串 | `glm-5.3-flash` | 传给 `claude --model` 的模型标识 |
| `maxConcurrentTurns` | 整数 >0 | 4 | 全局并发回合帽（资源保护；平台每用户 3 并发是内置常量） |
| `groupMentionName` | 非空字符串 | —（groups 非空时必填） | 群 @-提及匹配名：群消息须以 `@<名>` 开头才处理 |

## 开发

```sh
bun install
bun run typecheck     # tsc --noEmit
bun test              # unit + integration（mock WeCom WS 服务端 + fake claude，无需真实凭据）
bun run test:soak     # 10 min soak（AC2 时长证据）
bun run build         # dist（SDK external）
bun run check:dist    # dist 洁净门：无机器路径 / shebang / 双运行时冒烟
```

## License

MIT
