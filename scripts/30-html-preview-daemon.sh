#!/bin/bash
# Check-then-start html-preview local daemon.
# Idempotent: probes Unix socket GET /v1/health; if not logged in yet, exits 0 quietly.
set -u

CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/html-preview"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/html-preview"
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/html-preview"
CRED_FILE="$CONFIG_DIR/credentials.json"
SOCK="${HTML_PREVIEW_DAEMON_SOCK:-$STATE_DIR/daemon.sock}"
if [[ ${#SOCK} -gt 92 ]]; then
  SOCK="/tmp/hp-$(id -u)/d.sock"
fi

# If not logged in yet, exit 0 quietly so container boot is never blocked (PLAN.md §1.2.3)
if [[ -z "${HTML_PREVIEW_TOKEN:-}" ]]; then
  if [[ ! -f "$CRED_FILE" ]] || ! python3 -c '
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    s = d.get("servers") if isinstance(d.get("servers"), dict) else d
    ok = any(isinstance(v, dict) and str(v.get("token", "")).strip() for k, v in s.items() if k.startswith("http"))
    sys.exit(0 if ok else 1)
except Exception:
    sys.exit(1)
' "$CRED_FILE" 2>/dev/null; then
    echo "skipped: not logged in"
    exit 0
  fi
fi

# Locate the daemon bundle: explicit override, installed copy, then a source/skill checkout
BUNDLE="${HTML_PREVIEW_DAEMON_BUNDLE:-$DATA_DIR/daemon.mjs}"
if [[ ! -f "$BUNDLE" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  for cand in \
    "$SCRIPT_DIR/../dist/daemon.mjs" \
    "$SCRIPT_DIR/../skills/html-preview/scripts/daemon.mjs" \
    "/workspace/html-preview/dist/daemon.mjs" \
    "/workspace/html-preview/skills/html-preview/scripts/daemon.mjs"; do
    if [[ -f "$cand" ]]; then
      install -d -m 700 "$DATA_DIR"
      cp "$cand" "$DATA_DIR/daemon.mjs"
      BUNDLE="$DATA_DIR/daemon.mjs"
      break
    fi
  done
fi

if [[ ! -f "$BUNDLE" ]]; then
  echo "skipped: daemon bundle not installed"
  exit 0
fi

LOG_FILE="$STATE_DIR/logs/daemon.log"
install -d -m 700 "$CONFIG_DIR" "$STATE_DIR" "$(dirname "$SOCK")" "$(dirname "$LOG_FILE")"

is_up() {
  [[ -S "$SOCK" ]] && python3 -c '
import json, socket, sys
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.settimeout(1.5)
try:
    s.connect(sys.argv[1])
    s.sendall(b"GET /v1/health HTTP/1.0\r\nHost: localhost\r\n\r\n")
    raw = b""
    while True:
        chunk = s.recv(4096)
        if not chunk:
            break
        raw += chunk
    body = raw.split(b"\r\n\r\n", 1)[1]
    data = json.loads(body.decode("utf-8"))
    sys.exit(0 if data.get("ok") is True else 1)
except Exception:
    sys.exit(1)
finally:
    s.close()
' "$SOCK" >/dev/null 2>&1
}

if is_up; then
  echo "ok html-preview-daemon ($SOCK)"
  exit 0
fi

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if [[ -z "${HTML_PREVIEW_NODE_MODULES:-}" && -d "/workspace/html-preview/node_modules" ]]; then
  export HTML_PREVIEW_NODE_MODULES="/workspace/html-preview/node_modules"
fi
nohup node "$BUNDLE" serve \
  --config-dir "$CONFIG_DIR" \
  --state-dir "$STATE_DIR" \
  --socket "$SOCK" \
  --log-file "$LOG_FILE" \
  --if-not-running >>"$LOG_FILE" 2>&1 &

for _ in $(seq 1 40); do
  if is_up; then
    echo "started html-preview-daemon ($SOCK)"
    exit 0
  fi
  sleep 0.2
done

echo "html-preview-daemon start timed out"
exit 1
