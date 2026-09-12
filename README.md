# wechatbot

WeCom（企业微信）智能机器人 gateway——长连接模式。本仓库当前为 W1：transport 骨架 + 单聊文本 echo；
agent 会话层（spawn `claude` per chat）将在后续版本落地。完整行为契约见 [SPEC.md](./SPEC.md)。

## 安装

包发布在 GitHub Packages（scope 需与仓库 owner 一致）：

```ini
# .npmrc
@jacky402615:registry=https://npm.pkg.github.com
```

```sh
npm install @jacky402615/wechatbot
```

要求：Node ≥ 22 或 Bun ≥ 1.3（dist 双运行时可执行）。

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

## 开发

```sh
bun install
bun run typecheck     # tsc --noEmit
bun test              # unit + integration（mock WeCom WS 服务端，无需真实凭据）
bun run test:soak     # 10 min soak（AC2 时长证据）
bun run build         # dist（SDK external）
bun run check:dist    # dist 洁净门：无机器路径 / shebang / 双运行时冒烟
```

## License

MIT
