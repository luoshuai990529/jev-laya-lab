#!/bin/sh
set -eu
task_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$task_root"
if ! command -v node >/dev/null 2>&1; then
  echo '请先安装 Node.js 22 或更新版本：https://nodejs.org/'
  read -r task_exit
  exit 1
fi
node -e 'if(Number(process.versions.node.split(".")[0])<22){console.error("需要 Node.js 22 或更新版本");process.exit(1)}'
if curl -fsS --max-time 2 http://127.0.0.1:4317/api/bootstrap >/dev/null 2>&1; then
  open http://127.0.0.1:4317/
  exit 0
fi
echo '正在启动Jev × Laya 决策实验台。关闭这个终端窗口会停止应用和由应用启动的 Laya。'
(sleep 1; open http://127.0.0.1:4317/) &
exec node server/main.mjs
