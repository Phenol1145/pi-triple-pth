#!/usr/bin/env bash
set -euo pipefail

PLATFORM_DIR="${PLATFORM_DIR:-/data/platform}"
RELEASES_DIR="$PLATFORM_DIR/releases"
CURRENT_LINK="$RELEASES_DIR/current"
HEALTH_URL="http://localhost:3000/health"
HEALTH_TIMEOUT=30
MAX_ROLLBACKS=3
ROLLBACK_COUNT=0

log() { echo "[supervisor] $(date -Iseconds) $*"; }

health_check() {
  for i in $(seq 1 $HEALTH_TIMEOUT); do
    if curl -sf "$HEALTH_URL" > /dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

start_platform() {
  local release_dir="$1"
  log "Starting platform from $release_dir"
  cd "$release_dir"
  npm ci --silent
  npm run build --silent
  node dist/main.js &
  PLATFORM_PID=$!
}

rollback() {
  local prev_release="$1"
  log "ROLLBACK to $prev_release"
  kill "$PLATFORM_PID" 2>/dev/null || true
  wait "$PLATFORM_PID" 2>/dev/null || true
  ln -sfn "$prev_release" "$CURRENT_LINK"
  ROLLBACK_COUNT=$((ROLLBACK_COUNT + 1))
  if [ "$ROLLBACK_COUNT" -ge "$MAX_ROLLBACKS" ]; then
    log "ERROR: $MAX_ROLLBACKS consecutive rollbacks. Stopping. Manual intervention required."
    exit 1
  fi
  start_platform "$prev_release"
}

PREV_RELEASE=""
while true; do
  CURRENT_RELEASE=$(readlink -f "$CURRENT_LINK" 2>/dev/null || echo "")
  if [ -z "$CURRENT_RELEASE" ]; then
    log "No current release found. Waiting..."
    sleep 5
    continue
  fi

  start_platform "$CURRENT_RELEASE"

  if health_check; then
    log "Health check passed. Platform is healthy."
    ROLLBACK_COUNT=0
    PREV_RELEASE="$CURRENT_RELEASE"
  else
    log "Health check FAILED."
    if [ -n "$PREV_RELEASE" ] && [ "$PREV_RELEASE" != "$CURRENT_RELEASE" ]; then
      rollback "$PREV_RELEASE"
      continue
    else
      log "No previous release to roll back to. Stopping."
      exit 1
    fi
  fi

  while kill -0 "$PLATFORM_PID" 2>/dev/null; do
    if [ -f "$PLATFORM_DIR/.rebuild-request" ]; then
      log "Rebuild request detected."
      rm -f "$PLATFORM_DIR/.rebuild-request"
      kill -TERM "$PLATFORM_PID" 2>/dev/null || true
      wait "$PLATFORM_PID" 2>/dev/null || true
      break
    fi
    sleep 2
  done
  wait "$PLATFORM_PID" 2>/dev/null || true
done
