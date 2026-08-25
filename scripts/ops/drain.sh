#!/usr/bin/env bash
set -euo pipefail

PLATFORM_URL="${PLATFORM_URL:-http://localhost:3000}"
DRAIN_TIMEOUT="${DRAIN_TIMEOUT:-60}"

echo "Draining platform at $PLATFORM_URL..."

PID=$(pgrep -f "node dist/main.js" || true)
if [ -n "$PID" ]; then
  kill -TERM "$PID"
  echo "Sent SIGTERM to PID $PID. Waiting up to ${DRAIN_TIMEOUT}s..."
  for i in $(seq 1 "$DRAIN_TIMEOUT"); do
    if ! kill -0 "$PID" 2>/dev/null; then
      echo "Platform stopped gracefully."
      exit 0
    fi
    sleep 1
  done
  echo "Timeout. Force killing."
  kill -9 "$PID" 2>/dev/null || true
else
  echo "Platform process not found."
fi
