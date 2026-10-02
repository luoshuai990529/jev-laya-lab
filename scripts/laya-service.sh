#!/bin/sh
set -eu
task_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$task_root"
export UV_CACHE_DIR="$task_root/.local/cache/uv"
export UV_PYTHON_INSTALL_DIR="$task_root/.local/cache/python"
export HF_HOME="$task_root/.local/cache/huggingface"
export TORCH_HOME="$task_root/.local/cache/torch"
export LAYA_HOST=127.0.0.1 LAYA_PORT=8011 LAYA_PRELOAD=1 LAYA_MODELS=multilingual LAYA_MAX_LOADED=1
export PYTHONUNBUFFERED=1
if [ "${1:-start}" = 'prepare-and-start' ]; then
  if command -v uv >/dev/null 2>&1; then
    task_uv=$(command -v uv)
  elif [ -x "$HOME/.local/bin/uv" ]; then
    task_uv="$HOME/.local/bin/uv"
  else
    echo '需要先安装 uv（https://docs.astral.sh/uv/getting-started/installation/），或配置已有 Laya HTTP 服务。' >&2
    exit 1
  fi
  if [ ! -x .venv-laya/bin/python ]; then
    task_python="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3"
    if [ -x "$task_python" ]; then
      "$task_uv" venv --python "$task_python" .venv-laya
    else
      "$task_uv" venv --python 3.12 .venv-laya
    fi
  fi
  "$task_uv" pip install --python .venv-laya/bin/python 'laya[serve]==0.3.21'
fi
if [ ! -x .venv-laya/bin/laya-serve ]; then
  echo '本地 Laya 尚未准备，请在模型配置页点击“准备并启动 Laya”。' >&2
  exit 1
fi
echo '正在加载 multilingual 权重；首次运行需要联网下载，请保留此进程。'
exec .venv-laya/bin/laya-serve
