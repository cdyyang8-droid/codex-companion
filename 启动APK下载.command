#!/bin/zsh
cd "${0:A:h}"
if /usr/bin/curl -fsS --max-time 2 http://127.0.0.1:18378/ >/dev/null 2>&1; then
  open http://127.0.0.1:18378/
  exit 0
fi
companion_python=python3
[[ -x .venv/bin/python ]] && companion_python=.venv/bin/python
"$companion_python" scripts/serve_apk.py &
installer_pid=$!
trap 'kill "$installer_pid" 2>/dev/null' EXIT INT TERM
for attempt in {1..40}; do
  if /usr/bin/curl -fsS --max-time 1 http://127.0.0.1:18378/ >/dev/null 2>&1; then
    open http://127.0.0.1:18378/
    break
  fi
  if ! kill -0 "$installer_pid" 2>/dev/null; then
    echo '安装包下载服务未能启动，请查看上方提示。'
    read -r '?按回车退出'
    exit 1
  fi
  sleep 0.25
done
wait "$installer_pid"
