import * as vscode from 'vscode';
import { TerminalManager } from './terminalManager';
import { PtyTerminalManager } from './ptyTerminalManager';
import { ServerlessServer } from './serverlessServer';
import { HubServer } from './hubServer';
import { CONFIG_DEFAULTS, getSatelliteTimeoutMs } from './config';
import { initLogger, log } from './logger';

let workspace: string;
let statusBar: vscode.StatusBarItem;
let mode: 'auto' | 'client-only' = 'auto';
let terminalEngine: 'auto' | 'force-fallback' = 'auto';

let terminalManager: TerminalManager | undefined;
let ptyManager: PtyTerminalManager | undefined;
let agentServer: ServerlessServer | undefined;
let hubServer: HubServer | undefined;
let healthCheckTimer: NodeJS.Timeout | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let reconnectInFlight = false;
let hubLostRegistered = false;

type ConnectionState = 'connecting' | 'connected' | 'disconnected';
let state: ConnectionState = 'disconnected';

const outputChannel = vscode.window.createOutputChannel('VS Code MCP');
initLogger(outputChannel);

let host: string;
let port: number;
let satelliteTimeoutMs: number;

export async function activate(context: vscode.ExtensionContext) {
  log('Extension activating');

  workspace = vscode.workspace.name ||
    vscode.workspace.workspaceFolders?.[0]?.name ||
    'default';

  const config = vscode.workspace.getConfiguration('vscode-mcp');
  mode = config.get<'auto' | 'client-only'>('mode', 'auto');
  terminalEngine = config.get<'auto' | 'force-fallback'>('terminalEngine', 'auto');
  host = config.get<string>('host', CONFIG_DEFAULTS.host);
  port = config.get<number>('port', CONFIG_DEFAULTS.port);

  terminalManager = new TerminalManager(config.get<number>('outputBufferLines', CONFIG_DEFAULTS.outputBufferLines));
  ptyManager = new PtyTerminalManager();
  satelliteTimeoutMs = getSatelliteTimeoutMs();

  statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  context.subscriptions.push(statusBar);
  statusBar.command = 'vscode-mcp.statusBarClick';
  updateStatusBar();
  statusBar.show();

  context.subscriptions.push(
    vscode.debug.registerDebugAdapterTrackerFactory('*', {
      createDebugAdapterTracker() {
        return {
          onDidSendMessage(message: { type?: string; event?: string; body?: { output?: string; category?: string } }) {
            if (message.type === 'event' && message.event === 'output' && message.body?.output) {
              if (message.body.category !== 'telemetry') {
                agentServer?.appendDebugOutput(message.body.output, message.body.category);
              }
            }
          },
        };
      },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('vscode-mcp.statusBarClick', async () => {
      interface ActionItem extends vscode.QuickPickItem {
        action: string;
      }
      const items: ActionItem[] = [];

      items.push({ label: '$(info) Show Connection Status', action: 'status' });
      items.push({ label: '$(terminal) List Managed Terminals', action: 'list-terminals' });
      items.push({ label: '$(copy) Copy Workspace ID', description: `Copy "${workspace}" to clipboard`, action: 'copy-workspace' });

      if (state === 'disconnected') {
        items.push({ label: '$(plug) Connect', action: 'connect' });
      } else {
        items.push({ label: '$(debug-disconnect) Disconnect', action: 'disconnect' });
      }

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'VS Code MCP Extension - Choose action',
        title: 'MCP Connection Management'
      });

      if (!selected) return;

      switch (selected.action) {
        case 'status':
          vscode.window.showInformationMessage(
            `Workspace: ${workspace}\nState: ${state}\nTerminal engine: ${terminalEngine}\nPort: ${port}`
          );
          break;
        case 'list-terminals':
          const terminalList = terminalManager?.listTerminals() ?? [];
          const message = terminalList.length > 0
            ? terminalList.map(t => `"${t.name}"${t.hasShellIntegration ? ' [shell-integration]' : ' [no shell-integration]'}`).join('\n')
            : 'No active terminals';
          vscode.window.showInformationMessage(`Active terminals:\n${message}`);
          break;
        case 'copy-workspace':
          await vscode.env.clipboard.writeText(workspace);
          vscode.window.showInformationMessage(`Copied workspace ID "${workspace}" to clipboard`);
          break;
        case 'disconnect':
          await disconnect();
          vscode.window.showInformationMessage('VS Code MCP: Disconnected.');
          break;
        case 'connect':
          vscode.window.showInformationMessage('VS Code MCP: Connecting...');
          retryConnection();
          break;
      }
    }),
    vscode.commands.registerCommand('vscode-mcp.disconnect', async () => { await disconnect(); }),
    vscode.commands.registerCommand('vscode-mcp.reconnect', async () => {
      await disconnect();
      setTimeout(() => retryConnection(), 500);
    }),
    vscode.commands.registerCommand('vscode-mcp.listTerminals', async () => {
      const terminalList = terminalManager?.listTerminals() ?? [];
      const message = terminalList.length > 0
        ? terminalList.map(t => `"${t.name}"${t.hasShellIntegration ? ' [shell-integration]' : ' [no shell-integration]'}`).join('\n')
        : 'No active terminals';
      vscode.window.showInformationMessage(`Active terminals:\n${message}`);
    })
  );

  statusBar.tooltip = `VS Code MCP Extension\nClick to show status`;

  log(`Activated for workspace: ${workspace}`);

  if (!terminalManager || !ptyManager) return;
  agentServer = new ServerlessServer(terminalManager, ptyManager, workspace, terminalEngine, 2000);

  retryConnection();
}

async function retryConnection(): Promise<void> {
  if (reconnectInFlight) {
    log('retryConnection already in flight, skipping');
    return;
  }
  reconnectInFlight = true;
  stopReconnectTimer();
  setState('connecting');
  let delay = 1000;
  try {
    while (state === 'connecting') {
      try {
        await tryConnect();
        return;
      } catch (e) {
        log(`Connection attempt failed: ${e}`);
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 30000);
      }
    }
  } finally {
    reconnectInFlight = false;
  }
}

/**
 * Try to connect:
 * 1. If client-only mode → always join existing hub (or fail).
 * 2. In auto mode: try to become the hub by binding the port.
 *    If the port is already in use → join as satellite.
 */
async function tryConnect(): Promise<void> {
  if (!agentServer) {
    throw new Error('Agent server not initialized');
  }

  if (mode === 'client-only') {
    await connectAsSatellite();
    return;
  }

  // auto: try to become hub first
  let hubExists = false;
  try {
    const res = await fetch(`http://${host}:${port}/health`);
    hubExists = res.ok;
  } catch {
    hubExists = false;
  }
  if (hubExists) {
    await connectAsSatellite();
    return;
  }

  // No hub → try to start one
  try {
    await becomeHub();
    return;
  } catch (e) {
    // Port already in use (race condition - someone else became hub first)
    log(`Failed to become hub (${e}), trying satellite`);
    await connectAsSatellite();
  }
}

async function becomeHub(): Promise<void> {
  if (!agentServer) return;
  // Stop any satellite connection first so we don't reconnect to the hub we're about to become.
  agentServer.stop();
  const rawVersion = vscode.extensions.getExtension('prog76.vscode-mcp-extension')?.packageJSON.version;
  const extensionVersion = typeof rawVersion === 'number' ? String(rawVersion) : (rawVersion || 'unknown');
  hubServer = new HubServer(agentServer, workspace, extensionVersion, port, host, satelliteTimeoutMs);
  hubServer.onEvent((event) => {
    if (event.type === 'satellite-connected') {
      log(`Satellite connected: ${event.sessionId} (total: ${event.satelliteCount})`);
      vscode.window.showInformationMessage(
        `VS Code MCP: Satellite "${event.sessionId}" connected (${event.satelliteCount} total)`
      );
    } else {
      log(`Satellite disconnected: ${event.sessionId} (total: ${event.satelliteCount})`);
      vscode.window.showInformationMessage(
        `VS Code MCP: Satellite "${event.sessionId}" disconnected (${event.satelliteCount} remaining)`
      );
    }
    updateStatusBar();
  });
  await hubServer.start();
  setState('connected');
  log(`Hub listening at http://${host}:${port}`);
  vscode.window.showInformationMessage(
    `VS Code MCP: Hub started (session: "${workspace}") listening at http://${host}:${port}`
  );
}

async function connectAsSatellite(): Promise<void> {
  if (!agentServer) return;
  const wsUrl = `ws://${host}:${port}/ws`;
  if (!hubLostRegistered) {
    hubLostRegistered = true;
    agentServer.onHubLost(() => {
      log('Hub lost callback triggered');
      stopHealthCheck();
      setState('connecting');
      vscode.window.showWarningMessage('VS Code MCP: Hub lost, attempting to reconnect...');
      retryConnection();
    });
  }
  await agentServer.connectAsSatellite(wsUrl);
  setState('connected');
  log(`Connected as satellite to hub at ws://${host}:${port}`);
  vscode.window.showInformationMessage(
    `VS Code MCP: Connected as satellite to ws://${host}:${port} (session: "${workspace}")`
  );
  startHealthCheck();
}

export async function deactivate() {
  log('Extension deactivating');
  await disconnect();
  outputChannel.dispose();
}

async function disconnect(): Promise<void> {
  setState('disconnected');
  stopHealthCheck();
  stopReconnectTimer();
  reconnectInFlight = false;
  await hubServer?.stop();
  agentServer?.stop();
  hubServer = undefined;
  updateStatusBar();
}

function setState(newState: ConnectionState): void {
  if (state !== newState) {
    log(`State change: ${state} → ${newState}`);
    state = newState;
    updateStatusBar();
  }
}

function startHealthCheck(): void {
  stopHealthCheck();
  let failures = 0;
  healthCheckTimer = setInterval(async () => {
    try {
      const res = await fetch(`http://${host}:${port}/health`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      failures = 0;
    } catch (e) {
      failures++;
      log(`Health check failed (${failures}/3): ${e}`);
      if (failures >= 3) {
        stopHealthCheck();
        setState('connecting');
        vscode.window.showWarningMessage('VS Code MCP: Hub unreachable, reconnecting...');
        void retryConnection();
      }
    }
  }, 10000);
}

function stopHealthCheck(): void {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
  }
}

function stopReconnectTimer(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function updateStatusBar() {
  if (!statusBar) return;
  const config = vscode.workspace.getConfiguration('vscode-mcp');
  const showStatus = config.get<boolean>('showStatus', true);
  if (!showStatus) { statusBar.hide(); return; }
  statusBar.show();

  log(`updateStatusBar: state=${state} hub=${hubServer ? 'yes' : 'no'}`);

  switch (state) {
    case 'connecting':
      statusBar.text = '$(loading~spin) MCP';
      statusBar.color = new vscode.ThemeColor('statusBar.foreground');
      statusBar.tooltip = `VS Code MCP Connecting...\nSession: "${workspace}"\nClick to show status`;
      break;
    case 'connected':
      if (hubServer) {
        const satCount = hubServer.satelliteCount;
        statusBar.text = satCount > 0 ? `$(plug) MCP ${satCount}` : '$(plug) MCP';
        statusBar.tooltip = `VS Code MCP Hub — session "${workspace}" listening at http://${host}:${port}\nSatellites: ${satCount}\nEngine: ${terminalEngine}\nClick to show status`;
      } else {
        statusBar.text = '$(circle-outline) MCP';
        statusBar.tooltip = `VS Code MCP Satellite — session "${workspace}" connected to hub at ws://${host}:${port}\nEngine: ${terminalEngine}\nClick to show status`;
      }
      statusBar.color = new vscode.ThemeColor('statusBar.foreground');
      break;
    case 'disconnected':
      statusBar.text = '$(circle-slash) MCP';
      statusBar.color = new vscode.ThemeColor('statusBar.errorForeground');
      statusBar.tooltip = `VS Code MCP disconnected — session "${workspace}"\nConfigured port: ${port}\nClick to show status`;
      break;
  }
}