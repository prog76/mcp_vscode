#!/bin/sh
# vscode-mcp-agent container healthcheck.
#
# Two runtime modes (chosen downstream, e.g. by docker-compose):
#   router / server   (no --hub arg) -> the agent HOSTS an mcp-router on 27681 (HTTP /health + /mcp, WS /ws)
#   satellite         (--hub ws://..) -> agent DIALS OUT to the router and never listens
#
# The image-level healthcheck must not flag a healthy satellite as unhealthy
# just because it has no local HTTP port, so select the check from the argv of
# the running agent process. With compose `pid: "host"` /proc is the host's, so
# match the compiled entrypoint path to find our own process.
set -u

# Resolve the router bind host/port from the agent's cmdline (--host/--port).
# With compose `pid: "host"` /proc is the host's; match the compiled
# entrypoint path to find our own process.
agent_pid=$(pgrep -f '/app/agent/out/agent/src/main.js' | head -n1 || true)

router_port=27681
router_host=127.0.0.1
if [ -n "${agent_pid:-}" ]; then
    cmdline=$(tr '\0' '\n' <"/proc/${agent_pid}/cmdline" 2>/dev/null || true)
    h=$(printf '%s\n' "$cmdline" | grep -A1 '^--host$' | tail -n1)
    p=$(printf '%s\n' "$cmdline" | grep -A1 '^--port$' | tail -n1)
    [ -n "$h" ] && router_host=$h
    [ -n "$p" ] && router_port=$p
fi

# Client/stdio mode is explicit: --hub / --mode client / --mode stdio /
# VSCODE_MCP_AGENT_MODE=<that>. Neither listens on a local port, so the honest
# liveness signal is that the process itself is alive.
if [ -n "${agent_pid:-}" ] && { grep -q -- '--hub' "/proc/${agent_pid}/cmdline" 2>/dev/null \
    || printf '%s\n' "$cmdline" 2>/dev/null | grep -q -- '--mode client' \
    || printf '%s\n' "$cmdline" 2>/dev/null | grep -q -- '--mode stdio' \
    || [ "$(tr '\0' '\n' </proc/${agent_pid}/environ 2>/dev/null | grep '^VSCODE_MCP_AGENT_MODE=' | cut -d= -f2)" = "client" ] \
    || [ "$(tr '\0' '\n' </proc/${agent_pid}/environ 2>/dev/null | grep '^VSCODE_MCP_AGENT_MODE=' | cut -d= -f2)" = "stdio" ]; }; then
    kill -0 "${agent_pid}" 2>/dev/null
    exit $?
fi

# Router mode (or auto mode): require the HTTP API on the *bound* address.
# In auto mode the agent may currently be a satellite of an external router;
# then that router answers on the same address, so this passes while the
# satellite is genuinely serving through it — and fails (correctly)
# when the router is gone and the agent should have taken over.
curl -fsS "http://${router_host}:${router_port}/health" >/dev/null 2>&1