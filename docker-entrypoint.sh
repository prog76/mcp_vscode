#!/bin/sh
# Bootstrap the zg watcher daemon so the workspace index stays fresh as files
# change, then exec the agent. Every step here is best-effort: a failure must
# never prevent the agent from starting.

export ZVEC_GREP_HOME=/var/lib/agent-state/zvec-grep
export ZVEC_GREP_EMBEDDING=local/potion-code-16m-v2

if [ -d /workspace ]; then
  # 1. Start the watcher daemon (uses WORKDIR=/workspace). It keeps an
  #    existing index fresh but does NOT create the first index on a brand
  #    new workspace, so we bootstrap that next.
  zg server on >/dev/null 2>&1 || true

  # 2. If no index exists yet, build the initial one in the background so it
  #    is ready shortly after startup. The daemon picks it up and keeps it
  #    fresh from then on. Until it finishes, zg query falls back to ripgrep.
  if [ ! -f /workspace/.zvec-grep/manifest.json ]; then
    zg index /workspace >/dev/null 2>&1 || true
  fi
fi

exec node /app/agent/out/agent/src/main.js "$@"
