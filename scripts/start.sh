#!/bin/bash
set -eu
cd "$(dirname "$0")/.."
export AGENT_STATE_DIR="${AGENT_STATE_DIR:-$HOME/.local/state/durable-agent}"
mkdir -p "$AGENT_STATE_DIR"
chmod 700 "$AGENT_STATE_DIR"
exec flock --nonblock --no-fork "$AGENT_STATE_DIR/process.lock" node src/server.mjs
