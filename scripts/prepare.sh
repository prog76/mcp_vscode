#!/usr/bin/env bash
# Build the standalone agent from a git checkout (npm prepare on `npm i -g github:prog76/mcp_vscode#vX.Y.Z`).
# npm propagates the parent install env (npm_config_*) into lifecycle scripts, breaking nested
# npm install calls - so we re-exec with a clean environment.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
if [ -n "${npm_lifecycle_event:-}" ]; then
  exec env -i PATH="$PATH" HOME="$HOME" bash "$0" --clean-env
fi
cd "$ROOT"
npm install --prefix shared --no-audit --no-fund --silent
npm install --prefix agent --no-audit --no-fund --silent
"$ROOT/agent/node_modules/.bin/tsc" -p "$ROOT/agent/tsconfig.json"
echo "agent built: agent/out/agent/src/main.js"
