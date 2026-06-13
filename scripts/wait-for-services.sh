#!/usr/bin/env bash
# Wait until the dev/CI infrastructure services accept TCP connections.
# Usage: scripts/wait-for-services.sh [timeout_seconds]
set -euo pipefail

TIMEOUT="${1:-60}"

# name host port
SERVICES=(
  "postgres 127.0.0.1 ${POSTGRES_PORT:-5432}"
  "redis 127.0.0.1 ${REDIS_PORT:-6379}"
  "minio 127.0.0.1 ${MINIO_PORT:-9000}"
  "mailpit 127.0.0.1 ${MAILPIT_SMTP_PORT:-1025}"
)

wait_for() {
  local name="$1" host="$2" port="$3"
  local elapsed=0
  echo "Waiting for ${name} (${host}:${port})..."
  until (exec 3<>"/dev/tcp/${host}/${port}") 2>/dev/null; do
    sleep 2
    elapsed=$((elapsed + 2))
    if [ "${elapsed}" -ge "${TIMEOUT}" ]; then
      echo "ERROR: ${name} not reachable on ${host}:${port} after ${TIMEOUT}s" >&2
      return 1
    fi
  done
  echo "  ${name} is up."
}

for entry in "${SERVICES[@]}"; do
  # shellcheck disable=SC2086
  wait_for ${entry}
done

echo "All services are reachable."
