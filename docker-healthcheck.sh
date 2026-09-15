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

# Resolve the hub bind host/port from the agent's cmdline (--host/--port).
# With compose `pid: "host"` /proc is the host's; match the compiled
# entrypoint path to find our own process.
agent_pid=$(pgrep -f '/app/agent/out/agent/src/main.js' | head -n1 || true)

hub_port=27681
hub_host=127.0.0.1
if [ -n "${agent_pid:-}" ]; then
    cmdline=$(tr '\0' '\n' <"/proc/${agent_pid}/cmdline" 2>/dev/null || true)
    h=$(printf '%s\n' "$cmdline" | grep -A1 '^--host$' | tail -n1)
    p=$(printf '%s\n' "$cmdline" | grep -A1 '^--port$' | tail -n1)
    [ -n "$h" ] && hub_host=$h
    [ -n "$p" ] && hub_port=$p
fi

# Client mode is explicit: --hub / --mode client / VSCODE_MCP_AGENT_MODE=client.
# The honest liveness signal is that the process owning the outbound hub
# WebSocket is alive (a satellite never listens locally).
if [ -n "${agent_pid:-}" ] && { grep -q -- '--hub' "/proc/${agent_pid}/cmdline" 2>/dev/null \
    || printf '%s\n' "$cmdline" 2>/dev/null | grep -q -- '--mode client' \
    || [ "$(tr '\0' '\n' </proc/${agent_pid}/environ 2>/dev/null | grep '^VSCODE_MCP_AGENT_MODE=' | cut -d= -f2)" = "client" ]; }; then
    kill -0 "${agent_pid}" 2>/dev/null
    exit $?
fi

# Hub mode (or auto mode): require the HTTP API on the *bound* address.
# In auto mode the agent may currently be a satellite of an external hub;
# then the external hub answers on the same address, so this passes while
# the satellite is genuinely serving through it — and fails (correctly)
# when the hub is gone and the agent should have taken over.
curl -fsS "http://${hub_host}:${hub_port}/health" >/dev/null 2>&1