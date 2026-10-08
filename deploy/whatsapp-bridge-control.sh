#!/bin/sh
# start | stop | restart | ensure | status for grokbot-whatsapp-bridge.
# Copied from the Telegram bridge's bridge-control.sh and adapted:
#  - config is a mode-600 JSON file (no .env), auth/ must be mode 700
#  - ensure also reads state/status.json: it refuses to restart after a
#    terminal WhatsApp state (logged-out, needs-pairing, ...) and warns when a
#    configured group is not visible to the paired account.
set -eu
umask 077

BRIDGE_HOME=${BRIDGE_HOME:-/home/box/grokbot-whatsapp-bridge}
CONFIG_FILE=${WA_BRIDGE_CONFIG:-$BRIDGE_HOME/config.json}
PID_FILE="$BRIDGE_HOME/bridge.pid"
LOG_FILE="$BRIDGE_HOME/bridge.log"
LOCK_DIR="$BRIDGE_HOME/.control-lock"
STATUS_FILE=${WA_BRIDGE_STATUS:-$BRIDGE_HOME/state/status.json}
AUTH_DIR=${WA_BRIDGE_AUTH:-$BRIDGE_HOME/auth}
CONNECT_WAIT_SECONDS=${CONNECT_WAIT_SECONDS:-60}
HEARTBEAT_STALE_SECONDS=${HEARTBEAT_STALE_SECONDS:-300}

acquire_lock() {
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    lock_pid=$(cat "$LOCK_DIR/pid" 2>/dev/null || true)
    case "$lock_pid" in
      (*[!0-9]*|'') lock_pid= ;;
    esac
    if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null; then
      echo "Another whatsapp-bridge-control command is running" >&2
      exit 1
    fi
    rm -f "$LOCK_DIR/pid"
    if ! rmdir "$LOCK_DIR" 2>/dev/null || ! mkdir "$LOCK_DIR" 2>/dev/null; then
      echo "Could not recover the stale control lock" >&2
      exit 1
    fi
  fi
  printf '%s\n' "$$" >"$LOCK_DIR/pid"
  trap 'rm -f "$LOCK_DIR/pid"; rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT
  trap 'exit 130' HUP INT TERM
}

is_running() {
  [ -f "$PID_FILE" ] || return 1
  pid=$(cat "$PID_FILE")
  case "$pid" in (*[!0-9]*|'') return 1 ;; esac
  kill -0 "$pid" 2>/dev/null || return 1
  [ "$(readlink "/proc/$pid/cwd" 2>/dev/null || true)" = "$BRIDGE_HOME" ] || return 1
  command=$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || true)
  case "$command" in
    (*" src/main.js --config $CONFIG_FILE "*) return 0 ;;
    (*) return 1 ;;
  esac
}

# Print one field of status.json (empty if missing). Never prints secrets:
# status.json holds only state, timestamps, masked account and group JIDs.
status_field() {
  [ -f "$STATUS_FILE" ] || return 0
  node -e '
    const fs = require("fs");
    try {
      const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const v = s[process.argv[2]];
      process.stdout.write(v === undefined || v === null ? "" : Array.isArray(v) ? v.join(" ") : String(v));
    } catch {}
  ' "$STATUS_FILE" "$1"
}

heartbeat_age() {
  [ -f "$STATUS_FILE" ] || { echo 999999; return 0; }
  node -e '
    const fs = require("fs");
    try {
      const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const t = Date.parse(s.updatedAt);
      process.stdout.write(String(Number.isFinite(t) ? Math.round((Date.now() - t) / 1000) : 999999));
    } catch { process.stdout.write("999999"); }
  ' "$STATUS_FILE"
}

is_terminal_state() {
  case "$(status_field state)" in
    (needs-pairing|logged-out|connection-replaced|forbidden|bad-session) return 0 ;;
    (*) return 1 ;;
  esac
}

check_files() {
  if [ ! -f "$CONFIG_FILE" ]; then
    echo "Missing $CONFIG_FILE (copy config.example.json and fill it in)" >&2
    exit 1
  fi
  if [ "$(stat -c '%a' "$CONFIG_FILE")" != "600" ]; then
    echo "$CONFIG_FILE must have mode 600" >&2
    exit 1
  fi
  if [ ! -f "$AUTH_DIR/creds.json" ]; then
    echo "No WhatsApp session in $AUTH_DIR. Pair first: node src/pair.js --config $CONFIG_FILE --code <number>" >&2
    exit 3
  fi
  if [ "$(stat -c '%a' "$AUTH_DIR")" != "700" ]; then
    # A box restart can loosen modes. Re-tighten only our own real directory.
    if [ ! -L "$AUTH_DIR" ] && [ "$(stat -c '%u' "$AUTH_DIR")" = "$(id -u)" ]; then
      echo "Tightening $AUTH_DIR to mode 700 (was $(stat -c '%a' "$AUTH_DIR"))" >&2
      chmod 700 "$AUTH_DIR" && find "$AUTH_DIR" -maxdepth 1 -type f -exec chmod 600 {} +
    fi
    if [ "$(stat -c '%a' "$AUTH_DIR")" != "700" ]; then
      echo "$AUTH_DIR must have mode 700" >&2
      exit 1
    fi
  fi
}

start() {
  if is_running; then
    echo "WhatsApp bridge is already running"
    return
  fi
  rm -f "$PID_FILE"
  check_files
  if is_terminal_state; then
    echo "ALERT: last WhatsApp state is '$(status_field state)': $(status_field detail)" >&2
    echo "Not starting. Fix it (usually re-pair), then run: $0 clear-alert && $0 start" >&2
    exit 3
  fi
  cd "$BRIDGE_HOME"
  env -u WA_BRIDGE_CONFIG nohup node src/main.js --config "$CONFIG_FILE" >>"$LOG_FILE" 2>&1 &
  pid=$!
  printf '%s\n' "$pid" >"$PID_FILE"
  sleep 1
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "WhatsApp bridge failed to start; inspect $LOG_FILE" >&2
    exit 1
  fi
  echo "WhatsApp bridge started (pid $pid)"
}

wait_connected() {
  remaining=$CONNECT_WAIT_SECONDS
  while [ "$remaining" -gt 0 ]; do
    state=$(status_field state)
    case "$state" in
      (connected) break ;;
      (needs-pairing|logged-out|connection-replaced|forbidden|bad-session)
        echo "ALERT: WhatsApp state '$state': $(status_field detail)" >&2
        return 3 ;;
    esac
    if ! is_running; then
      echo "WhatsApp bridge exited during startup; inspect $LOG_FILE" >&2
      return 1
    fi
    sleep 2
    remaining=$((remaining - 2))
  done
  if [ "$(status_field state)" != "connected" ]; then
    echo "WARNING: WhatsApp socket not connected after ${CONNECT_WAIT_SECONDS}s (state: $(status_field state))" >&2
    return 4
  fi
  report_groups
}

report_groups() {
  missing=$(status_field groupsMissing)
  check=$(status_field groupsCheck)
  if [ -n "$missing" ]; then
    echo "WARNING: configured group(s) NOT visible to the paired WhatsApp account: $missing" >&2
    return 5
  fi
  if [ "$check" = "failed" ]; then
    echo "WARNING: could not list WhatsApp groups at startup; see $LOG_FILE" >&2
    return 5
  fi
  return 0
}

stop() {
  if ! is_running; then
    rm -f "$PID_FILE"
    echo "WhatsApp bridge is not running"
    return
  fi
  pid=$(cat "$PID_FILE")
  kill "$pid"
  remaining=20
  while kill -0 "$pid" 2>/dev/null && [ "$remaining" -gt 0 ]; do
    sleep 1
    remaining=$((remaining - 1))
  done
  if kill -0 "$pid" 2>/dev/null; then
    echo "WhatsApp bridge did not stop within 20 seconds" >&2
    return 1
  fi
  rm -f "$PID_FILE"
  echo "WhatsApp bridge stopped"
}

# ensure: silent (exit 0) when running + connected + all groups visible.
# Starts it when dead, restarts it when the heartbeat is stale (hung),
# never restarts after a terminal WhatsApp state (exit 3 = human needed).
ensure() {
  if is_terminal_state; then
    echo "ALERT: WhatsApp state '$(status_field state)': $(status_field detail)" >&2
    exit 3
  fi
  if ! is_running; then
    echo "WhatsApp bridge was not running; starting"
    start
    wait_connected
    return $?
  fi
  age=$(heartbeat_age)
  if [ "$age" -gt "$HEARTBEAT_STALE_SECONDS" ]; then
    echo "WhatsApp bridge heartbeat is ${age}s old; restarting"
    stop
    start
    wait_connected
    return $?
  fi
  case "$(status_field state)" in
    (connected) report_groups ;;
    (*) echo "WARNING: WhatsApp bridge running but state is '$(status_field state)' (reconnect attempts: $(status_field reconnectAttempts))" >&2; return 4 ;;
  esac
}

status() {
  if is_running; then
    echo "WhatsApp bridge is running (state: $(status_field state), account: $(status_field account), groups visible: $(status_field groupsVisible), missing: $(status_field groupsMissing))"
  else
    echo "WhatsApp bridge is not running (last state: $(status_field state))"
    exit 1
  fi
}

clear_alert() {
  if [ -f "$STATUS_FILE" ]; then
    node -e '
      const fs = require("fs");
      const f = process.argv[1];
      const s = JSON.parse(fs.readFileSync(f, "utf8"));
      s.previousState = s.state; s.state = "stopped"; s.alert = false; s.clearedAt = new Date().toISOString();
      fs.writeFileSync(f + ".tmp", JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
      fs.renameSync(f + ".tmp", f);
    ' "$STATUS_FILE"
  fi
  echo "Alert cleared"
}

case "${1:-}" in
  start) acquire_lock; start; wait_connected ;;
  stop) acquire_lock; stop ;;
  restart) acquire_lock; stop; start; wait_connected ;;
  ensure) acquire_lock; ensure ;;
  status) status ;;
  clear-alert) acquire_lock; clear_alert ;;
  *) echo "Usage: $0 {start|stop|restart|ensure|status|clear-alert}" >&2; exit 2 ;;
esac
