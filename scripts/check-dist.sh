#!/usr/bin/env bash
# AC6: dist 不得包含构建机绝对路径（feishubot #76 教训），SDK 保持 external，CLI 入口双运行时可执行。
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f dist/cli.js ] || { echo "FAIL: dist/cli.js 不存在（先 bun run build）"; exit 1; }
if grep -rnE '/home/|/Users/|/root/|/tmp/|[A-Za-z]:\\\\' dist/; then
  echo "FAIL: dist 内嵌机器路径"; exit 1
fi
head -1 dist/cli.js | grep -q '^#!' || { echo "FAIL: dist/cli.js 缺 shebang"; exit 1; }
# SDK external：import 语句存在 + SDK 源码未内联（协议串只在 SDK 内部出现）
grep -qE 'from[[:space:]]*"@wecom/aibot-node-sdk"|require\([[:space:]]*"@wecom/aibot-node-sdk"\)' dist/cli.js \
  || { echo "FAIL: dist 未以 import/require 引用 SDK"; exit 1; }
if grep -rq 'aibot_subscribe' dist/; then
  echo "FAIL: dist 内联了 SDK 源码（aibot_subscribe 出现）——SDK 必须外部化"; exit 1
fi
bun dist/cli.js --help | grep -q 'status'    # 冒烟断言帮助文本真实输出（防空转退出 0 的假绿）
node dist/cli.js --help | grep -q 'status'   # node 强制冒烟（--target=node 契约，同样断言文本）
echo "OK: dist clean and runnable"
