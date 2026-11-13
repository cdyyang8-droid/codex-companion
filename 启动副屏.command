#!/bin/zsh
cd "${0:A:h}"
if /usr/bin/curl -fsS --max-time 2 http://127.0.0.1:18377/api/health >/dev/null 2>&1; then
  open http://127.0.0.1:18377
  exit 0
fi
if ! command -v python3 >/dev/null; then
  echo '需要安装 Python 3.10 或更新版本。'
  read -r '?按回车退出'
  exit 1
fi
companion_python=python3
[[ -x .venv/bin/python ]] && companion_python=.venv/bin/python
"$companion_python" monitor.py &
monitor_pid=$!
trap 'kill "$monitor_pid" 2>/dev/null' EXIT INT TERM
for attempt in {1..40}; do
  if /usr/bin/curl -fsS --max-time 1 http://127.0.0.1:18377/api/health >/dev/null 2>&1; then
    open http://127.0.0.1:18377
    break
  fi
  if ! kill -0 "$monitor_pid" 2>/dev/null; then
    echo '启动失败，请查看上方错误信息。'
    read -r '?按回车退出'
    exit 1
  fi
  sleep 0.25
done
wait "$monitor_pid"
