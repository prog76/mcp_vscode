# VS Code MCP Extension

Exposes VS Code terminals as MCP tools for AI agents.

## Architecture

```
┌──────────────────────────────────────────────────────┐
│ Central Server (Python, localhost:9876)               │
│  - Single MCP endpoint: /mcp                          │
│  - Routes by workspace name                           │
│  - Manages extension registry                         │
└──────────────────────────────────────────────────────┘
           ↑ HTTP                           ↑
           │                                 │
  ┌────────┴──────┐                 ┌────────┴──────────┐
  │ VS Code #1    │                 │ VS Code #2        │
  │ Extension     │                 │ Extension         │
  │ Workspace:    │                 │ Workspace:        │
  │ "project-a"   │                 │ "project-b"       │
  └───────────────┘                 └───────────────────┘
```

## Components

### 1. Central MCP Server (`vscode_mcp_server.py`)

Python server that:
- Exposes MCP endpoint at `http://localhost:9876/mcp`
- All tools take `workspace` as first argument
- Routes tool calls to registered VS Code extensions
- Manages extension lifecycle (heartbeat, cleanup)

**Run:**
```bash
cd vscode
python vscode_mcp_server.py                    # Default port 9876
python vscode_mcp_server.py --port 9999        # Custom port
```

### 2. VS Code Extension (`extension/`)

TypeScript extension that:
- Starts local HTTP server to receive tool calls
- Registers with central server on activation
- Uses VS Code API to manage terminals
- Tracks terminal output for reading

**Install:**
```bash
cd vscode/extension
npm install
npm run compile
# Then use "Extensions: Install from VSIX..." in VS Code
```

## Usage

### Agent Configuration

```json
{
  "mcpServers": {
    "vscode": {
      "url": "http://localhost:9876/mcp"
    }
  }
}
```

### Available Tools

All tools take `workspace` as the first argument:

#### `terminal_create`
Create a new terminal in a workspace.

```python
terminal_create(
    workspace="my-project",
    name="Agent Terminal",
    cwd="/path/to/project"  # optional
)
# Returns: terminal_id (string)
```

#### `terminal_exec`
Execute a command in a terminal.

```python
terminal_exec(
    workspace="my-project",
    terminal_id="term_abc123",
    command="ls -la"
)
# Returns: "Executed"
```

#### `terminal_read`
Read terminal output since last read.

```python
terminal_read(
    workspace="my-project",
    terminal_id="term_abc123",
    since_index=0  # 0 = all, use returned next_index for incremental
)
# Returns: JSON string with output and next_index
```

#### `terminal_list`
List all active terminals in a workspace.

```python
terminal_list(workspace="my-project")
# Returns: JSON array of terminal info
```

#### `terminal_kill`
Kill a terminal.

```python
terminal_kill(
    workspace="my-project",
    terminal_id="term_abc123"
)
# Returns: "Killed"
```

### Example Workflow

```python
# Create terminal
term_id = terminal_create(workspace="my-project", name="Build")

# Execute command
terminal_exec(workspace="my-project", terminal_id=term_id, command="npm install")

# Read output
result = terminal_read(workspace="my-project", terminal_id=term_id, since_index=0)
data = json.loads(result)
print(data['output'])  # Terminal output
next_index = data['next_index']

# Read more output later
result = terminal_read(workspace="my-project", terminal_id=term_id, since_index=next_index)
```

## Policy Proxy Integration

Add to your policy configuration:

```yaml
# dev/config/mcp-gateways/policy/vscode.yaml
backend:
  name: vscode
  url: http://localhost:9876
  path: /mcp/vscode
  transport: http

rules:
  # Deny dangerous commands
  - match:
      tool: "terminal_exec"
      command: "^(rm|sudo|chmod|chown|dd|mkfs)\\b"
    action: deny
    reason: "Dangerous command blocked"

  # Require confirmation for git force operations
  - match:
      tool: "terminal_exec"
      command: "git (push --force|reset --hard|rebase)"
    action: confirm
    reason: "Destructive git operation requires approval"

  # Allow read-only commands
  - match:
      tool: "terminal_exec"
      command: "^(cat|less|head|tail|grep|ls|echo|pwd|whoami)\\b"
    action: allow

  # Default deny
  - match:
      tool: ".*"
    action: deny
    reason: "No matching policy rule"
```

Agent connects through policy proxy:
```json
{
  "mcpServers": {
    "vscode": {
      "url": "http://policy-proxy:8000/mcp/vscode"
    }
  }
}
```

## Extension Settings

- `vscode-mcp.serverUrl`: URL of central MCP server (default: `http://localhost:9876`)
- `vscode-mcp.heartbeatInterval`: Heartbeat interval in seconds (default: 30)
- `vscode-mcp.localPort`: Local port for extension server (default: 0 = random)

## API Reference

### Central Server Endpoints

#### `POST /register`
Register a VS Code extension.

**Request:**
```json
{
  "workspace": "my-project",
  "extension_url": "http://localhost:9877"
}
```

**Response:**
```json
{
  "status": "registered",
  "workspace": "my-project",
  "endpoint": "/mcp"
}
```

#### `POST /heartbeat`
Send heartbeat to keep registration alive.

**Request:**
```json
{
  "workspace": "my-project"
}
```

**Response:**
```json
{
  "status": "ok"
}
```

#### `GET /workspaces`
List all registered workspaces.

**Response:**
```json
{
  "workspaces": [
    {
      "name": "my-project",
      "url": "http://localhost:9877",
      "last_heartbeat_seconds_ago": 5.2,
      "registered_at": "2024-01-01T12:00:00"
    }
  ]
}
```

#### `GET /health`
Health check.

**Response:**
```json
{
  "status": "ok",
  "extensions_count": 2,
  "workspaces": ["my-project", "other-project"]
}
```

### Extension Local Server Endpoints

#### `POST /execute`
Execute a tool via VS Code API.

**Request:**
```json
{
  "tool": "terminal_create",
  "arguments": {
    "name": "My Terminal",
    "cwd": "/path/to/project"
  }
}
```

**Response:**
```json
{
  "result": "term_abc123"
}
```

## Installation

### From PyPI (recommended)

```bash
pip install vscode-mcp
```

### From GitHub

```bash
pip install git+https://github.com/oscaryard/vscode-mcp
```

### From source

```bash
git clone https://github.com/oscaryard/vscode-mcp
cd vscode-mcp
pip install -e .
```

### Run the server

```bash
# Using the installed command
vscode-mcp-server --port 9876

# Or using Python module
python -m vscode_mcp --port 9876
```

## Development

### Setup Central Server

```bash
cd vscode
pip install -r ../../mcp/requirements.txt
python vscode_mcp_server.py
```

### Setup Extension

```bash
cd vscode/extension
npm install
npm run compile
```

Press F5 in VS Code to launch Extension Development Host.

## Troubleshooting

**Extension not registering:**
- Check central server is running: `curl http://localhost:9876/health`
- Check extension logs: View → Output → VS Code MCP Extension
- Check central server logs for registration attempts

**Tool calls failing:**
- Verify workspace name matches: `curl http://localhost:9876/workspaces`
- Check extension is running: Look for status bar icon
- Check local server is running: Extension logs should show port

**Terminal output not captured:**
- Output is only captured after extension activates
- Buffer limited to last 1000 lines
- Terminal must be created via MCP tools (not manually)

## License

MIT
