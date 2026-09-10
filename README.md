# VS Code MCP Extension — Implementation Summary

## What Was Built

A VS Code extension that exposes VS Code terminals, IDE features, and direct shell execution to AI agents via the Model Context Protocol (MCP). The extension runs entirely in the VS Code UI process (TypeScript) and connects to MCP clients through a hub/satellite WebSocket mesh.

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│ MCP Client (agent)                                          │
│  - connects to hub via MCP protocol                        │
└──────────────────────────┬─────────────────────────────────┘
                           │
┌──────────────────────────▼─────────────────────────────────┐
│ Hub (one VS Code window acts as hub)                       │
│  - exposes TOOLS list + routes tool calls                  │
│  - WebSocket server for satellites                         │
└──────────────────────────┬─────────────────────────────────┘
                           │ WebSocket (register/execute/result)
              ┌────────────┴────────────┐
              │                         │
┌─────────────▼──────────┐  ┌───────────▼──────────────┐
│ Satellite VS Code #1   │  │ Satellite VS Code #2     │
│  - ServerlessServer    │  │  - ServerlessServer      │
│  - session_id="proj-a" │  │  - session_id="proj-b"   │
└────────────────────────┘  └──────────────────────────┘
```

## Components

### 1. Hub Server (`hubServer.ts`)
- **MCP server** that exposes the full tool list to the agent
- **WebSocket server** for satellite registration and tool-call routing
- Routes each tool call to the satellite matching the requested `session_id`
- Handles timeouts, reconnects, and hub-lost notifications

### 2. Satellite / Serverless Server (`serverlessServer.ts`)
- Runs in every VS Code window (including the hub itself)
- **`TOOLS` array** — the complete MCP tool schema
- **`invokeTool()`** — dispatches tool calls to the right handler
- **`directExecute()`** — runs shell commands directly via `child_process.spawn` (no terminal tab)
- Connects to the hub via WebSocket as a satellite

### 3. Terminal Managers
- **`terminalManager.ts`** — shell-integration engine (real TTY, exit codes, `cd`/env persistence, busy detection)
- **`ptyTerminalManager.ts`** — node-pty fallback engine when shell integration is unavailable

## Tools Exposed

All tools take `session_id` (the VS Code workspace identifier, e.g. `llm [SSH: VDI-LS]`).

### Terminal tools
- `terminal_list_sessions` — list connected VS Code windows
- `terminal_create` — create a named terminal (unique name: `prefix`, `prefix_1`, ...)
- `terminal_list` — list terminals created via `terminal_create`
- `terminal_run` — execute a command in a VS Code terminal, capture output
- `terminal_wait` — wait for a running command to finish, get output + exit code
- `terminal_send_text` — send input to a terminal (answer prompts, send `\x03`/`\x04`)
- `terminal_read_output` — read raw buffered terminal output
- `terminal_clear_buffer` — clear a terminal's output buffer

### Direct execution
- `execute` — run a shell command **directly** (NOT via VS Code terminal) and capture output

```python
# Run a command directly (no terminal)
execute(command="echo hello && echo oops 1>&2")
# -> stdout: "hello", stderr: "oops", exit code: 0

# Pipe stdin
execute(command="cat -n", stdin="line1\nline2")
# -> stdout: "1 line1\n2 line2", exit code: 0

# Limit output size (default is ~49 KB)
execute(command="cat bigfile.log", max_output_bytes=10000)
# -> stdout: truncated at 10000 bytes ... [output truncated at 10000 bytes (~10 KB)]
```

**`execute` parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `command` | string | yes | Shell command to execute (run via shell) |
| `stdin` | string | no | String piped to the process stdin, then stream closed |
| `cwd` | string | no | Working directory (defaults to workspace folder root) |
| `timeout_ms` | number | no | Hard timeout (default: `vscode-mcp.terminalRunTimeoutMs` = 300000). On expiry: process killed (SIGTERM→SIGKILL), partial output returned |
| `max_output_bytes` | number | no | Max combined stdout+stderr size before truncation (default: `vscode-mcp.maxOutputBytes` = 50000 ≈ 49 KB) |
| `env` | object | no | Extra env vars merged on top of process.env |
| `session_id` | string | yes | Workspace identifier |

**`execute` output:** stdout, then a `--- stderr ---` section (if any), then `[exit code: N]`. On truncation: `[output truncated at N bytes (~N KB) — use terminal_run to see more]`. On timeout: `[STILL RUNNING — timed out after Ns, process killed, no exit code.]`

### IDE tools
- `get_diagnostics` — errors/warnings/hints from open files or a specific file
- `get_document_symbols` — symbol outline of a file
- `get_references` — find all references of a symbol
- `rename_symbol` — rename a symbol across the workspace
- `run_command` — execute any VS Code command by ID
- `open_file` — open a file in the editor (visual action only)
- `format_document` — format a file and save
- `organize_imports` — remove unused + sort imports, save
- `fix_all` — apply all auto-fixable diagnostics, save
- `save_all` — save all open files
- `find_in_files` — open workspace search panel
- `get_hover_info` — type info/docs for a symbol

### Debug tools
- `debug_breakpoints` — add/remove/list/clear breakpoints
- `debug_start` — start a debug session
- `debug_stop` — stop a debug session
- `debug_state` — snapshot of threads, call stacks, scopes, variables
- `debug_control` — continue/pause/step/restart/evaluate
- `debug_console_output` — read debug console output

## Terminal Engine

The extension uses **shell integration** by default (real TTY, exit codes, `cd`/env persistence, busy detection). If shell integration is unavailable (e.g. `ash`/Alpine shells), it falls back to a **node-pty** engine. `terminal_list` reports each terminal's engine (`[shell-integration]` vs `[no shell-integration]`).

## Configuration

Settings (all under `vscode-mcp.*`):
- `host` / `port` — hub server address
- `mode` — `auto` (probe server, use client mode if reachable else serverless) or `client-only`
- `terminalEngine` — `auto` or `force-fallback`
- `outputBufferLines` — max lines of terminal output to buffer
- `satelliteTimeoutMs` — timeout for waiting on a satellite
- `terminalRunTimeoutMs` — default hard wait for `terminal_run` (default 300000)
- `terminalWaitTimeoutMs` — default max block for `terminal_wait` (default 300000)
- `shellReadDrainMs` — drain time for shell-integration read stream
- `shellStartBindMs` — max wait for shell start event rebind
- `terminalCreateWarmupMs` — warmup wait after `terminal_create`
- `maxOutputBytes` — default max output size for `execute` (default 50000 ≈ 49 KB)

## Standalone Agent — Manual Mode

The standalone agent (`vscode-mcp-agent`, built from `agent/`) defaults to auto-detection
(`--mode auto`): it probes the hub port and connects as a satellite when a hub is reachable,
otherwise it starts its own hub. Use `--mode` to pick the role explicitly — required for
containers/systemd where a probe (or a hub fallback) is wrong:

| Mode | Meaning | Equivalent (legacy) |
|------|---------|---------------------|
| `auto` (default) | probe hub port → satellite if reachable, else hub | old default |
| `server` | always act as hub (serve MCP HTTP + satellite WebSocket), never connect out | `--standalone` |
| `client` | always connect as satellite to `--hub` (default `ws://<host>:<port>`), never start a hub | — |

The same selector is honored via the `VSCODE_MCP_AGENT_MODE` env var (CLI `--mode` wins).
Invalid combos are rejected at startup: `--mode server` + `--hub`, `--standalone` + `--mode client`,
and any unknown mode value.

## Docker Image

`ghcr.io/prog76/vscode-mcp-agent` — built & pushed by
[`.github/workflows/docker.yml`](.github/workflows/docker.yml) on every `v*` tag (`latest` on `main`).
The image carries an AI-ready CLI toolset so `execute`/`terminal_*` tools are useful in the
container: zvec-grep (`zg`, hybrid semantic + lexical search with indexing), ripgrep (`rg`),
ast-grep (`sg`, structural/AST search), ripsed (bulk find/replace/delete), `jq`, `git`,
`curl`, `less`, `procps`, and the `docker` CLI (talks to the host daemon via the mounted
`/var/run/docker.sock`). Human-interactive tools (`fzf`, `bat`, `fd-find`) and `repgrep`
(`rgr`) are intentionally not installed — `zg`/`rg`/`sg`/`ripsed` cover those use cases.

A **`zg` watcher daemon** (`zg server on`) runs automatically from the entrypoint: it keeps
the `/workspace` index fresh as files change, so agent edits are re-indexed within seconds
and `zg query` stays current with no manual re-indexing. It uses the fully-offline local
embedding model `local/potion-code-16m-v2` (no API key, model cached in the `agent-state`
volume). See `deploy/config/skills/agent-search-edit-tools.md` for usage from the agent's
perspective.

Build:

```bash
docker build -t ghcr.io/prog76/vscode-mcp-agent:latest .
```

Run as a **server** (default cwd is `/workspace`):

```bash
docker run --rm -p 27681:27681 -v "$HOME/src:/workspace" \
  ghcr.io/prog76/vscode-mcp-agent --mode server --host 0.0.0.0
```

Run as a **client/satellite** (dials `--hub`, no probe, no hub fallback):

```bash
docker run --rm ghcr.io/prog76/vscode-mcp-agent \
  --mode client --hub ws://<hub-host>:27681
```

Mounting `~/src` at `/workspace` (read-write) puts every repo in the container, so the agent can
search and edit code there. The container deliberately runs as root because the mounted `~/src`
is owned by an arbitrary host uid — restrict with a compose `user:` override if your layout allows.

## Build

```bash
cd vscode-mcp/extension
npm install
npm run compile   # tsc -p ./
```

## License

MIT