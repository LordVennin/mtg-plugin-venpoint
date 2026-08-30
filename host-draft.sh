#!/usr/bin/env bash
# Host a draft over Cloudflare quick tunnels — one command, one shareable URL.
#
#   ./host-draft.sh
#
# Starts a local web server + PeerJS signaling server (loopback only, no
# firewall ports needed), opens a Cloudflare quick tunnel in front of each,
# and prints the single URL that you AND your friends open. Ctrl+C stops
# everything. Tunnel URLs are random and change on every run.
#
# Requirements: python3, node/npx, curl. cloudflared is used from PATH if
# installed, otherwise a static binary is downloaded to .cache/ on first run.
#
# Options via environment: WEB_PORT (default 8000), PEER_PORT (default 9000).

set -euo pipefail
cd "$(dirname "$0")"

WEB_PORT="${WEB_PORT:-8000}"
PEER_PORT="${PEER_PORT:-9000}"
CACHE_DIR=".cache"
mkdir -p "$CACHE_DIR"

log() { printf '\033[1;33m[draft]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[draft]\033[0m %s\n' "$*" >&2; exit 1; }

command -v python3 >/dev/null 2>&1 || die "python3 is required"
command -v npx     >/dev/null 2>&1 || die "node/npx is required (install nodejs)"
command -v curl    >/dev/null 2>&1 || die "curl is required"

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

# ---------- local servers (loopback only; the tunnels are the public face) ----------
log "Starting web server on 127.0.0.1:$WEB_PORT"
python3 -m http.server "$WEB_PORT" --bind 127.0.0.1 >"$CACHE_DIR/web.log" 2>&1 &
PIDS+=($!)

log "Starting PeerJS signaling server on 127.0.0.1:$PEER_PORT"
npx --yes --package=peer peerjs --port "$PEER_PORT" --host 127.0.0.1 >"$CACHE_DIR/peerjs.log" 2>&1 &
PIDS+=($!)

for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PEER_PORT/" >/dev/null 2>&1; then break; fi
  [ "$i" = 30 ] && die "PeerJS server did not start; see $CACHE_DIR/peerjs.log"
  sleep 1
done
log "Local servers up."

# ---------- tunnels ----------
start_tunnel() { # $1 = local port, $2 = log file
  : >"$2"
  "$CLOUDFLARED" tunnel --no-autoupdate --url "http://127.0.0.1:$1" >"$2" 2>&1 &
  PIDS+=($!)
}

wait_tunnel_url() { # $1 = log file → prints https://xxx.trycloudflare.com
  for i in $(seq 1 60); do
    url=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$1" | head -1 || true)
    if [ -n "$url" ]; then echo "$url"; return 0; fi
    sleep 1
  done
  return 1
}

log "Opening Cloudflare quick tunnels (takes ~15s)…"
start_tunnel "$WEB_PORT"  "$CACHE_DIR/tunnel-web.log"
start_tunnel "$PEER_PORT" "$CACHE_DIR/tunnel-peer.log"

WEB_URL=$(wait_tunnel_url "$CACHE_DIR/tunnel-web.log")  || die "Web tunnel failed; see $CACHE_DIR/tunnel-web.log"
PEER_URL=$(wait_tunnel_url "$CACHE_DIR/tunnel-peer.log") || die "Signaling tunnel failed; see $CACHE_DIR/tunnel-peer.log"
PEER_HOST="${PEER_URL#https://}"

SHARE_URL="$WEB_URL/?peerhost=$PEER_HOST"
echo
log "READY — open this URL yourself AND send it to your friends:"
echo
printf '    \033[1;36m%s\033[0m\n' "$SHARE_URL"
echo
log "Everyone uses that same link. Create a room, share the 5-letter code."
log "Keep this terminal open for the whole draft. Ctrl+C stops everything."
wait
