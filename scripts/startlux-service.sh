#!/bin/sh
# Run the official GGUF decision wrapper; weights and binaries stay in .local.
set -eu
task_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
task_model=${STARTLUX_MODEL_DIR:-"$task_root/.local/startlux/model"}
task_python=${STARTLUX_PYTHON:-"$task_root/.venv-laya/bin/python"}
task_llama=${STARTLUX_LLAMA_SERVER:-"$task_root/.local/startlux/llama/llama-b11368/llama-server"}
if [ ! -x "$task_llama" ] || [ ! -x "$task_python" ] || [ ! -f "$task_model/StartLux-Decision-4B-Q8_0.gguf" ]; then
  echo '请先按 docs/startlux.md 准备 llama.cpp、Python 环境和官方 4B Q8 权重。' >&2
  exit 1
fi
# Refuse occupied ports instead of accidentally pairing with an unrelated service.
"$task_python" - <<'PYPORT'
import socket
for port in (8081,8090):
    with socket.socket() as sock:
        try: sock.bind(('127.0.0.1', port))
        except OSError: raise SystemExit(f'端口 {port} 已被占用，请先检查已有服务。')
PYPORT
task_llama_pid=''
task_wrapper_pid=''
cleanup() {
  trap - EXIT INT TERM HUP
  [ -z "$task_wrapper_pid" ] || kill "$task_wrapper_pid" 2>/dev/null || true
  [ -z "$task_llama_pid" ] || kill "$task_llama_pid" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
mkdir -p "$task_root/.local/startlux"
"$task_llama" -m "$task_model/StartLux-Decision-4B-Q8_0.gguf" -ngl 99 -c 16384 --parallel 4 --host 127.0.0.1 --port 8081 >"$task_root/.local/startlux/llama.log" 2>&1 &
task_llama_pid=$!
task_tries=0
until curl -fsS --max-time 2 http://127.0.0.1:8081/health >/dev/null 2>&1; do
  kill -0 "$task_llama_pid" 2>/dev/null || { tail -20 "$task_root/.local/startlux/llama.log"; exit 1; }
  task_tries=$((task_tries+1))
  [ "$task_tries" -lt 120 ] || { echo '模型加载超时'; exit 1; }
  sleep 1
done
cd "$task_model"
echo 'StartLux 4B Q8：模型后端已就绪，正在启动决策接口 http://127.0.0.1:8090/v1/systemone'
"$task_python" -m startlux_decision.gguf_server --model-dir . --llama http://127.0.0.1:8081 --port 8090 --name StartLux-Decision-4B-Q8_0 &
task_wrapper_pid=$!
wait "$task_wrapper_pid"
