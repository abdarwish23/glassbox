#!/usr/bin/env bash
# Glassbox — single-file deployment (DESIGN.md §9).
#
# The platform clones this repo and runs this script; it must do
# everything: install dependencies, seed the demo DB if absent, start the
# sandbox worker sidecar (localhost-only, scrubbed environment — it is the
# security boundary and holds no secrets), wait until a worker is warm,
# then start the agent service in the foreground on $PORT.
#
# Idempotent: safe to run repeatedly. Fail-fast: set -euo pipefail.
set -euo pipefail
cd "$(dirname "$0")"

log() { echo "[glassbox run.sh] $*"; }

PORT="${PORT:-8080}"
WORKER_PORT="${WORKER_PORT:-8079}"
POOL_SIZE="${POOL_SIZE:-2}"
DB_PATH="${GLASSBOX_DB_PATH:-demo/glassbox-demo.db}"

# --- 1. dependencies -------------------------------------------------------
if [ -d node_modules ] && [ -f package-lock.json ]; then
  log "node_modules present — skipping install"
elif [ -f package-lock.json ]; then
  log "installing dependencies (npm ci)…"
  npm ci --no-audit --no-fund
else
  log "installing dependencies (npm install)…"
  npm install --no-audit --no-fund
fi

# --- 2. demo data ----------------------------------------------------------
if [ ! -f "$DB_PATH" ]; then
  log "seeding demo database at $DB_PATH…"
  GLASSBOX_DB_PATH="$DB_PATH" node demo/seed.mjs
else
  log "demo database exists at $DB_PATH — not reseeding"
fi

# --- 3. sandbox worker sidecar (scrubbed env, localhost only) --------------
# env -i: the sidecar starts from an empty environment and receives only
# the allowlist below. DB paths and LLM keys are NEVER passed to it.
log "starting worker sidecar on 127.0.0.1:$WORKER_PORT (pool=$POOL_SIZE)…"
env -i \
  PATH="$PATH" \
  HOME="${HOME:-/tmp}" \
  NODE_USE_ENV_PROXY="${NODE_USE_ENV_PROXY:-1}" \
  NODE_EXTRA_CA_CERTS="${NODE_EXTRA_CA_CERTS:-}" \
  SSL_CERT_FILE="${SSL_CERT_FILE:-}" \
  http_proxy="${http_proxy:-}" https_proxy="${https_proxy:-}" \
  HTTP_PROXY="${HTTP_PROXY:-}" HTTPS_PROXY="${HTTPS_PROXY:-}" \
  ALL_PROXY="${ALL_PROXY:-}" all_proxy="${all_proxy:-}" \
  NO_PROXY="127.0.0.1,localhost" no_proxy="127.0.0.1,localhost" \
  WORKER_PORT="$WORKER_PORT" \
  POOL_SIZE="$POOL_SIZE" \
  node worker/server.mjs &
SIDECAR_PID=$!

AGENT_PID=""
cleanup() {
  [ -n "$AGENT_PID" ] && kill "$AGENT_PID" 2>/dev/null || true
  kill "$SIDECAR_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# --- 4. wait for a warm worker --------------------------------------------
log "waiting for the sandbox pool to warm (first cold start can take a minute)…"
READY=0
for i in $(seq 1 300); do
  if curl -sf "http://127.0.0.1:$WORKER_PORT/healthz" 2>/dev/null | grep -q '"ready":true'; then
    READY=1
    break
  fi
  if ! kill -0 "$SIDECAR_PID" 2>/dev/null; then
    log "ERROR: worker sidecar died during startup"
    exit 1
  fi
  sleep 1
done
if [ "$READY" != "1" ]; then
  log "ERROR: worker pool did not become ready in 300s"
  exit 1
fi
log "worker pool is warm"

# --- 5. agent service (foreground) -----------------------------------------
log "starting agent service on port $PORT…"
PORT="$PORT" \
WORKER_URL="http://127.0.0.1:$WORKER_PORT" \
GLASSBOX_DB_PATH="$DB_PATH" \
  node agent/server.mjs &
AGENT_PID=$!
wait "$AGENT_PID"
