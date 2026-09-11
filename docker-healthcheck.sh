#!/bin/sh
# vscode-mcp-agent container healthcheck.
#
# Two runtime modes (chosen downstream, e.g. by docker-compose):
#   hub / server   (no --hub arg) -> agent LISTENS on 27681 (HTTP /health + WS /ws)
#   satellite      (--hub ws://..) -> agent DIALS OUT to the hub and never listens
#
# The image-level healthcheck must not flag a healthy satellite as unhealthy
# just because it has no local HTTP port, so select the check from the argv of
# the running agent process. With compose `pid: "host"` /proc is the host's, so
# match the compiled entrypoint path to find our own process.
set -u

agent_pid=$(pgrep -f '/app/agent/out/agent/src/main.js' | head -n1 || true)

if [ -n "${agent_pid:-}" ] && grep -q -- '--hub' "/proc/${agent_pid}/cmdline" 2>/dev/null; then
    # Satellite mode: the honest liveness signal is that the agent process that
    # owns the outbound hub WebSocket is alive.
    kill -0 "${agent_pid}" 2>/dev/null
    exit $?
fi

# Hub mode (or process not found yet): require the local HTTP API.
curl -fsS http://127.0.0.1:27681/health >/dev/null 2>&1