import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import * as child_process from 'child_process';

let localServer: http.Server | undefined;
let heartbeatInterval: NodeJS.Timeout | undefined;
let workspace: string;
let connectionState: 'connecting' | 'connected' | 'disconnected' = 'disconnected';
let statusBar: vscode.StatusBarItem;
let serverUrl: string;
let extensionUrl: string;

export async function activate(context: vscode.ExtensionContext) {
  console.log('VS Code MCP Extension is activating');

  // Get workspace name
  workspace = vscode.workspace.name ||
    vscode.workspace.workspaceFolders?.[0]?.name ||
    'default';

  // Get configuration
  const config = vscode.workspace.getConfiguration('vscode-mcp');
  serverUrl = config.get<string>('serverUrl', 'http://localhost:9876');
  const heartbeatIntervalSec = config.get<number>('heartbeatInterval', 30);
  const localPort = config.get<number>('localPort', 0);

  // Start local server
  const actualPort = await startLocalServer(context, localPort);
  extensionUrl = `http://localhost:${actualPort}`;

  console.log(`Local server started on port ${actualPort}`);
  console.log(`Registering workspace: ${workspace}`);

  // Create status bar item
  statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  updateStatusBar();
  statusBar.show();

  // Register with central server
  connectToServer().catch(err => {
    console.error('Failed to connect to central server:', err);
  });

  // Start heartbeat
  heartbeatInterval = setInterval(() => {
    sendHeartbeat().catch(err => {
      console.error('Heartbeat failed:', err);
    });
  }, heartbeatIntervalSec * 1000);

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('vscode-mcp.statusBarClick', async () => {
      if (connectionState === 'disconnected') {
        vscode.window.showInformationMessage(`Connecting to MCP server: ${serverUrl}...`);
        try {
          await connectToServer();
          vscode.window.showInformationMessage(`Connected to MCP server: ${serverUrl}`);
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to connect: ${error}`);
        }
      } else if (connectionState === 'connected') {
        const info = await getStatus();
        vscode.window.showInformationMessage(
          `Workspace: ${workspace}\n` +
          `Server: ${serverUrl}\n` +
          `Local: ${extensionUrl}\n` +
          `Status: ${connectionState}`
        );
      }
      // When connecting, do nothing (already in progress)
    }),

    vscode.commands.registerCommand('vscode-mcp.connect', async () => {
      await connectToServer();
      vscode.window.showInformationMessage(`Connected to MCP server: ${serverUrl}`);
    }),

    vscode.commands.registerCommand('vscode-mcp.disconnect', async () => {
      await disconnectFromServer();
      vscode.window.showInformationMessage(`Disconnected from MCP server`);
    }),

    vscode.commands.registerCommand('vscode-mcp.listTerminals', async () => {
      const terminals = getTerminalList();
      const message = terminals.length > 0
        ? terminals.map(t => `${t.id}: ${t.name}`).join('\n')
        : 'No active terminals';
      vscode.window.showInformationMessage(`Active terminals:\n${message}`);
    }),

    statusBar
  );

  // Set up status bar click handler
  statusBar.command = 'vscode-mcp.statusBarClick';

  console.log(`VS Code MCP Extension activated for workspace: ${workspace}`);
}

export async function deactivate() {
  console.log('VS Code MCP Extension deactivating');

  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
  }

  // Disconnect from server on deactivate
  await disconnectFromServer();

  if (localServer) {
    localServer.close();
    localServer = undefined;
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
// Connection Management
// ---------------------------------------------------------------------------

async function connectToServer() {
  connectionState = 'connecting';
  updateStatusBar();

  try {
    const response = await httpRequest(`${serverUrl}/api/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        workspace,
        extension_url: extensionUrl
      })
    });

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`Registration failed: ${response.statusCode}`);
    }

    const data = JSON.parse(response.body);
    console.log('Registered with central server:', data);
    connectionState = 'connected';
    updateStatusBar();
  } catch (error) {
    console.error('Failed to connect to central server:', error);
    connectionState = 'disconnected';
    updateStatusBar();
    throw error;
  }
}

async function disconnectFromServer() {
  try {
    if (connectionState === 'connected') {
      await httpRequest(`${serverUrl}/api/unregister`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          workspace
        })
      });
    }
  } catch (error) {
    console.error('Error during disconnect:', error);
  }
  connectionState = 'disconnected';
  updateStatusBar();
}

// ---------------------------------------------------------------------------
// Local HTTP Server
// ---------------------------------------------------------------------------

interface TerminalInfo {
  id: string;
  name: string;
  terminal: vscode.Terminal;
  outputBuffer: string[];
  cwd: string;
}

const terminals = new Map<string, TerminalInfo>();

// Execute command and capture output using child_process
function executeCommandWithOutput(command: string, cwd?: string): Promise<string> {
  return new Promise((resolve) => {
    const workspacePath = cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
    child_process.exec(command, { cwd: workspacePath }, (error, stdout, stderr) => {
      if (error) {
        resolve(`Error: ${error.message}`);
      } else {
        resolve(stdout || stderr || '');
      }
    });
  });
}

function startLocalServer(context: vscode.ExtensionContext, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/execute') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
          try {
            const { tool, arguments: args } = JSON.parse(body);
            console.log(`Executing tool: ${tool}`, args);

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

                result = id;
                break;
              }

              case 'terminal_exec': {
                const term = terminals.get(args.terminal_id);
                if (!term) {
                  result = 'Error: Terminal not found';
                } else {
                  // Execute command and capture output immediately
                  const output = await executeCommandWithOutput(args.command, term.cwd);
                  result = output;
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

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ result }));
          } catch (error) {
            console.error('Error executing tool:', error);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ result: `Error: ${error}` }));
          }
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    server.listen(port, 'localhost', () => {
      const actualPort = (server.address() as any).port;
      console.log(`Local server listening on port ${actualPort}`);
      localServer = server;
      resolve(actualPort);
    });

    server.on('error', (err) => {
      console.error('Server error:', err);
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// Central Server Communication
// ---------------------------------------------------------------------------

async function sendHeartbeat() {
  if (connectionState !== 'connected') return;

  try {
    const response = await httpRequest(`${serverUrl}/api/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        workspace
      })
    });

    if (response.statusCode < 200 || response.statusCode >= 300) {
      console.error('Heartbeat failed:', response.statusCode);
      connectionState = 'disconnected';
      updateStatusBar();
    }
  } catch (error) {
    console.error('Heartbeat error:', error);
    connectionState = 'disconnected';
    updateStatusBar();
  }
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

// Simple HTTP request helper using Node's built-in http module
function httpRequest(url: string, options: any): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const urlStr = String(url);
    const urlObj = new URL(urlStr);
    const client = urlObj.protocol === 'https:' ? https : http;

    const reqOptions: any = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: options.method,
      headers: options.headers
    };

    const req = client.request(reqOptions, (res: http.IncomingMessage) => {
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
