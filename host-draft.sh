#!/usr/bin/env bash
# Host a draft over a Cloudflare quick tunnel — one command, one shareable URL.
#
#   ./host-draft.sh
#
# Runs the relay server (which serves the app AND relays draft messages over
# WebSockets — no WebRTC, so it works under any NAT/VPN/CGNAT), opens one
# Cloudflare quick tunnel in front of it, and prints the URL that you AND
# your friends open. Ctrl+C stops everything. The tunnel URL is random and
# changes on every run.
#
# Requirements: node + npm, curl. cloudflared is used from PATH if installed,
# otherwise a static binary is downloaded to .cache/ on first run.
#
# Options via environment: PORT (default 8000).

set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8000}"
CACHE_DIR=".cache"
mkdir -p "$CACHE_DIR"

log() { printf '\033[1;33m[draft]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[draft]\033[0m %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "node is required (install nodejs)"
command -v npm  >/dev/null 2>&1 || die "npm is required"
command -v curl >/dev/null 2>&1 || die "curl is required"

# ---------- dependencies ----------
if [ ! -d node_modules/ws ]; then
  log "Installing dependencies (first run only)…"
  npm install --no-audit --no-fund >/dev/null
fi

# ---------- cloudflared: system binary, or download a static one ----------
if command -v cloudflared >/dev/null 2>&1; then
  CLOUDFLARED=cloudflared
else
  CLOUDFLARED="$CACHE_DIR/cloudflared"
  if [ ! -x "$CLOUDFLARED" ]; then
    case "$(uname -s)-$(uname -m)" in
      Linux-x86_64)              ASSET=cloudflared-linux-amd64 ;;
      Linux-aarch64|Linux-arm64) ASSET=cloudflared-linux-arm64 ;;
      Darwin-*) die "On macOS install cloudflared first: brew install cloudflared" ;;
      *)        die "Unsupported platform $(uname -s)-$(uname -m); install cloudflared manually" ;;
    esac
    log "Downloading cloudflared ($ASSET)…"
    curl -fSL --progress-bar -o "$CLOUDFLARED" \
      "https://github.com/cloudflare/cloudflared/releases/latest/download/$ASSET" \
      || die "cloudflared download failed"
    chmod +x "$CLOUDFLARED"
  fi
fi

# ---------- cleanup on exit ----------
PIDS=()
cleanup() {
  log "Shutting down…"
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# ---------- relay server (serves the app + relays draft messages) ----------
log "Starting relay server on 127.0.0.1:$PORT"
node relay-server.mjs --port "$PORT" --host 127.0.0.1 >"$CACHE_DIR/relay.log" 2>&1 &
PIDS+=($!)

for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then break; fi
  [ "$i" = 30 ] && die "Relay server did not start; see $CACHE_DIR/relay.log"
  sleep 1
done
log "Relay server up."

# ---------- tunnel ----------
: >"$CACHE_DIR/tunnel.log"
log "Opening Cloudflare quick tunnel (takes ~15s)…"
"$CLOUDFLARED" tunnel --no-autoupdate --url "http://127.0.0.1:$PORT" >"$CACHE_DIR/tunnel.log" 2>&1 &
PIDS+=($!)

WEB_URL=""
for i in $(seq 1 60); do
  WEB_URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$CACHE_DIR/tunnel.log" | head -1 || true)
  [ -n "$WEB_URL" ] && break
  sleep 1
done
[ -n "$WEB_URL" ] || die "Tunnel failed to open; see $CACHE_DIR/tunnel.log"

SHARE_URL="$WEB_URL/?relay=1"
echo
log "READY — open this URL yourself AND send it to your friends:"
echo
printf '    \033[1;36m%s\033[0m\n' "$SHARE_URL"
echo
log "Everyone uses that same link. Create a room, share the 5-letter code."
log "Keep this terminal open for the whole draft. Ctrl+C stops everything."
wait
