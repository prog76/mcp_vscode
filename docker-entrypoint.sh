#!/bin/sh
# Bootstrap the zg watcher daemon so workspace indexes stay fresh as files
# change, then exec the agent. Every step here is best-effort: a failure must
# never prevent the agent from starting.
#
# Roots: ZVEC_GREP_ROOTS is a colon-separated list of index roots
# (default /workspace). Adding a corpus is a mount plus one entry here -
# no image change. Unmounted roots are skipped, so a corpus can be optional
# per deployment. Each root keeps its own index at <root>/.zvec-grep.
# Invariant: one writer per root - the container that mounts a root owns its
# index; other consumers of the same root only read it.

export ZVEC_GREP_HOME=${ZVEC_GREP_HOME:-/var/lib/agent-state/zvec-grep}
export ZVEC_GREP_EMBEDDING=${ZVEC_GREP_EMBEDDING:-local/potion-code-16m-v2}

# Start the watcher daemon (uses WORKDIR=/workspace). It keeps existing
# indexes fresh but does NOT create the first index on a brand new root, so we
# bootstrap that below. Reused if already running.
zg server on >/dev/null 2>&1 || true

for root in $(echo "${ZVEC_GREP_ROOTS:-/workspace}" | tr ':' ' '); do
  [ -d "$root" ] || continue
  if [ ! -f "$root/.zvec-grep/manifest.json" ]; then
    # Build the initial index in the background so it is ready shortly after
    # startup; the daemon keeps it fresh from then on. Until it finishes,
    # zg query falls back to ripgrep.
    #
    # One job at a time: concurrent first-index builds race on the shared
    # daemon and silently leave a root unindexed (verified - two parallel
    # jobs, one root produced a complete index while the other came up
    # empty). The trailing wait costs one index build at container start.
    ( cd "$root" && zg index "$root" ) >/dev/null 2>&1 &
    wait
  fi
done

exec node /app/agent/out/agent/src/main.js "$@"
