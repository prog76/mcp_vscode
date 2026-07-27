import * as vscode from 'vscode';

let ws: WebSocket | undefined;
let reconnectTimer: NodeJS.Timeout | undefined;
let heartbeatTimer: NodeJS.Timeout | undefined;
let workspace: string;
let connectionState: 'connecting' | 'connected' | 'disconnected' = 'disconnected';
let statusBar: vscode.StatusBarItem;
let serverUrl: string;
let shouldReconnect = true;

// Pending execute requests: requestId -> {resolve, reject, timer}
const pendingRequests = new Map<string, {
  resolve: (value: string) => void;
  reject: (reason: any) => void;
  timer: NodeJS.Timeout;
}>();

// ---------------------------------------------------------------------------
// Terminal Management
// ---------------------------------------------------------------------------

interface TerminalInfo {
  id: string;
  name: string;
  terminal: vscode.Terminal;
  outputBuffer: string[];
  cwd: string;
}

const terminals = new Map<string, TerminalInfo>();

// ---------------------------------------------------------------------------
// Activation / Deactivation
// ---------------------------------------------------------------------------

export async function activate(context: vscode.ExtensionContext) {
  console.log('VS Code MCP Extension is activating');

  // Get workspace name
  workspace = vscode.workspace.name ||
    vscode.workspace.workspaceFolders?.[0]?.name ||
    'default';

  // Get configuration
  const config = vscode.workspace.getConfiguration('vscode-mcp');
  serverUrl = config.get<string>('serverUrl', 'http://localhost:9876');

  // Create status bar item
  statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  updateStatusBar();
  statusBar.show();

  // Start WebSocket connection
  shouldReconnect = true;
  connectWebSocket();

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('vscode-mcp.statusBarClick', async () => {
      // Show a quick pick menu with available actions based on current state
      interface ActionItem extends vscode.QuickPickItem {
        action: string;
      }
      const items: ActionItem[] = [];

      if (connectionState === 'disconnected' || connectionState === 'connecting') {
        items.push({
          label: '$(plug) Connect to MCP Server',
          description: `Connect to ${serverUrl}`,
          action: 'connect'
        });
      }

      if (connectionState === 'connecting') {
        items.push({
          label: '$(circle-slash) Cancel Reconnection',
          description: 'Stop trying to connect',
          action: 'cancel-reconnect'
        });
      }

      if (connectionState === 'connected') {
        items.push({
          label: '$(plugs) Disconnect from MCP Server',
          action: 'disconnect'
        });
        items.push({
          label: '$(info) Show Connection Status',
          description: `Connected to ${serverUrl}`,
          action: 'status'
        });
      }

      items.push({
        label: '$(terminal) List Managed Terminals',
        action: 'list-terminals'
      });

      items.push({
        label: '$(gear) Change Server URL...',
        description: `Current: ${serverUrl}`,
        action: 'change-url'
      });

      if (workspace) {
        items.push({
          label: '$(copy) Copy Workspace ID',
          description: `Copy "${workspace}" to clipboard`,
          action: 'copy-workspace'
        });
      }

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'VS Code MCP Extension - Choose action',
        title: 'MCP Connection Management'
      });

      if (!selected) return;

      switch (selected.action) {
        case 'connect':
          shouldReconnect = true;
          connectWebSocket();
          vscode.window.showInformationMessage(`Connecting to MCP server: ${serverUrl}`);
          break;

        case 'cancel-reconnect':
          shouldReconnect = false;
          if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = undefined;
          }
          disconnectWebSocket();
          vscode.window.showInformationMessage('Reconnection cancelled');
          break;

        case 'disconnect':
          shouldReconnect = false;
          disconnectWebSocket();
          vscode.window.showInformationMessage('Disconnected from MCP server');
          break;

        case 'status':
          const info = await getStatus();
          vscode.window.showInformationMessage(
            `Workspace: ${workspace}\n` +
            `Server: ${serverUrl}\n` +
            `Status: ${connectionState}\n` +
            `Server response: ${JSON.stringify(info)}`
          );
          break;

        case 'list-terminals':
          const terminalList = getTerminalList();
          const message = terminalList.length > 0
            ? terminalList.map(t => `${t.id}: ${t.name}`).join('\n')
            : 'No active terminals';
          vscode.window.showInformationMessage(`Active terminals:\n${message}`);
          break;

        case 'copy-workspace':
          await vscode.env.clipboard.writeText(workspace);
          vscode.window.showInformationMessage(`Copied workspace ID "${workspace}" to clipboard`);
          break;

        case 'change-url':
          const newUrl = await vscode.window.showInputBox({
            prompt: 'Enter MCP Server URL',
            value: serverUrl,
            placeHolder: 'http://localhost:9876',
            validateInput: (value: string) => {
              if (!value.startsWith('http://') && !value.startsWith('https://')) {
                return 'URL must start with http:// or https://';
              }
              return null;
            }
          });
          if (newUrl) {
            serverUrl = newUrl;
            const mcpConfig = vscode.workspace.getConfiguration('vscode-mcp');
            await mcpConfig.update('serverUrl', newUrl, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(`Server URL updated to ${newUrl}. Reconnecting...`);
            shouldReconnect = true;
            disconnectWebSocket();
            connectWebSocket();
          }
          break;
      }
    }),

    vscode.commands.registerCommand('vscode-mcp.connect', async () => {
      shouldReconnect = true;
      connectWebSocket();
      vscode.window.showInformationMessage(`Connecting to MCP server: ${serverUrl}`);
    }),

    vscode.commands.registerCommand('vscode-mcp.disconnect', async () => {
      shouldReconnect = false;
      disconnectWebSocket();
      vscode.window.showInformationMessage(`Disconnected from MCP server`);
    }),

    vscode.commands.registerCommand('vscode-mcp.copyWorkspaceId', async () => {
      await vscode.env.clipboard.writeText(workspace);
      vscode.window.showInformationMessage(`Copied workspace ID "${workspace}" to clipboard`);
    }),

    vscode.commands.registerCommand('vscode-mcp.listTerminals', async () => {
      const terminalList = getTerminalList();
      const message = terminalList.length > 0
        ? terminalList.map(t => `${t.id}: ${t.name}`).join('\n')
        : 'No active terminals';
      vscode.window.showInformationMessage(`Active terminals:\n${message}`);
    }),

    statusBar
  );

  // Set up status bar click handler
  statusBar.command = 'vscode-mcp.statusBarClick';
  statusBar.tooltip = `VS Code MCP Extension\nClick to manage connection\n\nCommands available:\n- Connect to MCP Server\n- Disconnect from MCP Server\n- Copy Workspace ID\n- List Managed Terminals\n- Show MCP Status`;

  console.log(`VS Code MCP Extension activated for workspace: ${workspace}`);
}

export async function deactivate() {
  console.log('VS Code MCP Extension deactivating');
  shouldReconnect = false;
  disconnectWebSocket();
  cleanupTerminals();

  if (statusBar) {
    statusBar.dispose();
  }
}

// ---------------------------------------------------------------------------
// Status Bar Management
// ---------------------------------------------------------------------------

function updateStatusBar() {
  if (!statusBar) return;

  const config = vscode.workspace.getConfiguration('vscode-mcp');
  const showStatus = config.get<boolean>('showStatus', true);

  if (!showStatus) {
    statusBar.hide();
    return;
  }

  statusBar.show();

  switch (connectionState) {
    case 'connected':
      statusBar.text = '$(plug) MCP';
      statusBar.color = new vscode.ThemeColor('statusBar.foreground');
      statusBar.tooltip = `VS Code MCP: Connected to ${serverUrl}\nWorkspace: ${workspace}\nClick to show status`;
      break;
    case 'connecting':
      statusBar.text = '$(sync~spin) MCP';
      statusBar.color = new vscode.ThemeColor('statusBar.foreground');
      statusBar.tooltip = `VS Code MCP: Connecting to ${serverUrl}...\nWorkspace: ${workspace}`;
      break;
    case 'disconnected':
      statusBar.text = '$(error) MCP';
      statusBar.color = new vscode.ThemeColor('statusBar.errorForeground');
      statusBar.tooltip = `VS Code MCP: Disconnected from ${serverUrl}\nWorkspace: ${workspace}\nClick to connect`;
      break;
  }
}

// ---------------------------------------------------------------------------
// WebSocket Connection
// ---------------------------------------------------------------------------

let reconnectAttempts = 0;
let isConnecting = false; // Guard against concurrent connection attempts

function connectWebSocket() {
  // Prevent duplicate concurrent connection attempts
  if (isConnecting) {
    console.log('Already attempting to connect, skipping duplicate call');
    return;
  }

  // If we already have an open or connecting socket, skip
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    console.log('WebSocket already open or connecting, skipping');
    return;
  }

  // Clear any pending reconnect timer (defensive: avoid double-scheduled retries)
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }

  isConnecting = true;
  connectionState = 'connecting';
  updateStatusBar();

  // Convert http:// to ws://
  const wsUrl = serverUrl.replace(/^http:/, 'ws:').replace(/\/+$/, '') + '/ws';
  console.log(`Connecting WebSocket to ${wsUrl}`);

  try {
    // Create fresh WebSocket
    const newWs = new WebSocket(wsUrl);
    ws = newWs;

    newWs.onopen = () => {
      console.log('WebSocket connected');
      isConnecting = false;
      reconnectAttempts = 0; // Reset backoff on success
      connectionState = 'connected';
      updateStatusBar();

      // Register workspace
      sendMessage({
        type: 'register',
        workspace: workspace
      });

      // Start heartbeat (keep connection alive)
      startHeartbeat();
    };

    newWs.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleServerMessage(data);
      } catch (error) {
        console.error('Failed to parse server message:', error);
      }
    };

    newWs.onclose = (event) => {
      console.log(`WebSocket closed: code=${event.code} reason=${event.reason}`);
      isConnecting = false;
      connectionState = 'disconnected';
      updateStatusBar();
      stopHeartbeat();

      // Reject all pending requests
      for (const [requestId, pending] of pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error('WebSocket disconnected'));
        pendingRequests.delete(requestId);
      }

      // Auto-reconnect with exponential backoff (only if shouldReconnect and not disconnected by user)
      scheduleReconnect();
    };

    newWs.onerror = (error) => {
      console.error('WebSocket error:', error);
      // Note: onclose will fire after onerror, so reconnect is handled there
      // This avoids scheduling duplicate reconnect timers
    };
  } catch (error) {
    console.error('Failed to create WebSocket:', error);
    isConnecting = false;
    connectionState = 'disconnected';
    updateStatusBar();
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (!shouldReconnect) {
    console.log('Auto-reconnect disabled, not retrying');
    return;
  }

  if (reconnectTimer) {
    console.log('Reconnect already scheduled, skipping');
    return;
  }

  const delay = getReconnectDelay();
  console.log(`Scheduling reconnect in ${delay}ms (attempt #${reconnectAttempts})...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connectWebSocket();
  }, delay);
}

function getReconnectDelay(): number {
  // Exponential backoff: 1s, 2s, 4s, 8s, 16s, max 30s
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
  reconnectAttempts++;
  return delay;
}

function disconnectWebSocket() {
  shouldReconnect = false;
  reconnectAttempts = 0;
  isConnecting = false;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  stopHeartbeat();

  if (ws) {
    const oldWs = ws;
    ws = undefined;
    oldWs.onclose = null; // Prevent auto-reconnect from this socket
    oldWs.onerror = null;
    try { oldWs.close(); } catch (e) { /* ignore */ }
  }

  connectionState = 'disconnected';
  updateStatusBar();
}

// ---------------------------------------------------------------------------
// Heartbeat (keep connection alive, detect stale connections)
// ---------------------------------------------------------------------------

function startHeartbeat() {
  stopHeartbeat();
  // Send a ping every 30 seconds to keep the connection alive
  heartbeatTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      sendMessage({ type: 'ping' });
    }
  }, 30000);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }
}

// ---------------------------------------------------------------------------
// Message Handling
// ---------------------------------------------------------------------------

function sendMessage(data: any) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function handleServerMessage(data: any) {
  const type = data.type;

  switch (type) {
    case 'registered':
      console.log(`Registered workspace: ${data.workspace}`);
      reconnectAttempts = 0; // Reset reconnect attempts on successful registration
      break;

    case 'execute':
      handleExecuteRequest(data);
      break;

    case 'error':
      console.error('Server error:', data.message);
      break;

    case 'pong':
      // Server responded to our ping
      break;

    default:
      console.log('Unknown server message type:', type);
  }
}

// ---------------------------------------------------------------------------
// Tool Execution
// ---------------------------------------------------------------------------

async function handleExecuteRequest(data: any) {
  const requestId = data.requestId;
  const tool = data.tool;
  const args = data.arguments || {};

  console.log(`Executing tool: ${tool}`, args);

  try {
    let result: any;

    switch (tool) {
      case 'terminal_create': {
        const cwd = args.cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
        const terminal = vscode.window.createTerminal({
          name: args.name || 'MCP Terminal',
          cwd
        });

        const id = generateId();
        terminals.set(id, {
          id,
          name: args.name || 'MCP Terminal',
          terminal,
          outputBuffer: [],
          cwd
        });

        // Show the terminal
        terminal.show();

        result = id;
        break;
      }

      case 'terminal_exec': {
        const term = terminals.get(args.terminal_id);
        if (!term) {
          result = 'Error: Terminal not found';
        } else {
          // Send text to the terminal
          term.terminal.sendText(args.command);
          result = 'Executed';
        }
        break;
      }

      case 'terminal_read': {
        const term = terminals.get(args.terminal_id);
        if (!term) {
          result = { output: '', next_index: 0 };
        } else {
          const sinceIndex = args.since_index || 0;
          const output = term.outputBuffer.slice(sinceIndex).join('');
          result = {
            output,
            next_index: term.outputBuffer.length
          };
        }
        break;
      }

      case 'terminal_list': {
        result = Array.from(terminals.values()).map(t => ({
          id: t.id,
          name: t.name,
          cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
        }));
        break;
      }

      case 'terminal_kill': {
        const term = terminals.get(args.terminal_id);
        if (term) {
          term.terminal.dispose();
          terminals.delete(args.terminal_id);
          result = 'Killed';
        } else {
          result = 'Error: Terminal not found';
        }
        break;
      }

      default:
        result = `Error: Unknown tool: ${tool}`;
    }

    // Send result back over WebSocket
    sendMessage({
      type: 'result',
      requestId: requestId,
      result: typeof result === 'string' ? result : JSON.stringify(result)
    });
  } catch (error) {
    console.error(`Error executing tool ${tool}:`, error);
    sendMessage({
      type: 'error',
      requestId: requestId,
      message: String(error)
    });
  }
}

// ---------------------------------------------------------------------------
// HTTP Request Helper (for health check)
// ---------------------------------------------------------------------------

function httpRequest(url: string, options: any): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const http = require(url.startsWith('https') ? 'https' : 'http');
    const urlObj = new URL(url);

    const reqOptions: any = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: options.method,
      headers: options.headers
    };

    const req = http.request(reqOptions, (res: any) => {
      let body = '';
      res.on('data', (chunk: any) => body += chunk);
      res.on('end', () => {
        resolve({ statusCode: res.statusCode || 0, body });
      });
    });

    req.on('error', reject);

    if (options.body) {
      req.write(options.body);
    }

    req.end();
  });
}

async function getStatus(): Promise<any> {
  try {
    const response = await httpRequest(`${serverUrl}/api/health`, {});
    if (response.statusCode === 200) {
      return JSON.parse(response.body);
    }
    return { status: 'error', statusCode: response.statusCode };
  } catch (error) {
    return { status: 'error', error: String(error) };
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function generateId(): string {
  return Math.random().toString(36).substring(2, 15) +
    Math.random().toString(36).substring(2, 15);
}

function getTerminalList(): TerminalInfo[] {
  return Array.from(terminals.values());
}

function cleanupTerminals() {
  for (const [id, term] of terminals) {
    term.terminal.dispose();
  }
  terminals.clear();
}
