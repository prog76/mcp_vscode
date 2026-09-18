// Runtime module alias: map @vscode-mcp/shared/* to the compiled shared tree
// (tsconfig paths only affect type resolution, not node's runtime require).
try {
    const path = require('path');
    const Module = require('module');
    const origResolve = Module._resolveFilename;
    Module._resolveFilename = function (request: string, ...args: any[]): string {
        if (request.startsWith('@vscode-mcp/shared/')) {
            request = path.join(__dirname, '../../shared/src', request.slice('@vscode-mcp/shared/'.length));
        }
        return origResolve.call(this, request, ...args);
    };
} catch { /* noop */ }

import * as vscode from 'vscode';
import { TerminalManager } from './terminalManager';
import { PtyTerminalManager } from './ptyTerminalManager';
import { ServerlessServer, TOOLS } from './serverlessServer';
import { createRouter, Router, Facade } from 'mcp-router';
import { CONFIG_DEFAULTS, getSatelliteTimeoutMs, getTerminalRunTimeoutMs } from './config';
import { initLogger, log } from './logger';
import { setTracer } from '@vscode-mcp/shared/tracer';

let workspace: string;
let statusBar: vscode.StatusBarItem;
let mode: 'auto' | 'client-only' = 'auto';
let terminalEngine: 'auto' | 'force-fallback' = 'auto';

let terminalManager: TerminalManager | undefined;
let ptyManager: PtyTerminalManager | undefined;
let agentServer: ServerlessServer | undefined;
/** The router this window hosts (embedded), when it is the hub. */
let routerHost: { router: Router; facade: Facade } | undefined;
let healthCheckTimer: NodeJS.Timeout | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let reconnectInFlight = false;
// The original code calls retryConnection() immediately every time the hub
// drops (onHubLost) OR a connect attempt fails, which over a lossy link
// (e.g. VDI/SSH) produces a reconnect storm and serializes as repeated
// "Replacing existing satellite connection" on the hub. Mitigation: share the
// same exponential backoff that landed on the agent side -- base 2s with a
// max of 30s, growing after each failure / drop, and only reset to the base
// after a stable run (a long enough connected span).
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;
// Only reset the backoff after a connected span of this length -- a rapidly
// flapping link keeps the delay growing instead of reconnecting instantly.
const STABLE_CONNECTED_MS = 10000;

// Tracks the current backoff delay between reconnect attempts. Grows on every
// failed connection attempt AND on every hub-drop/reconnect cycle, and is
// reset to the base only after a stable run.
let reconnectDelayMs = RECONNECT_BASE_MS;

// Last moment the satellite appeared to have a live (registered) connection.
// Used to decide whether the drop should reset the backoff.
let lastConnectedAtMs = 0;
let hubLostRegistered = false;

type ConnectionState = 'connecting' | 'connected' | 'disconnected';
let state: ConnectionState = 'disconnected';

const outputChannel = vscode.window.createOutputChannel('VS Code MCP');
initLogger(outputChannel);
    setTracer((m) => log(m)); // full-power OutputChannel tracing for shared modules

let host: string;
let port: number;
let satelliteTimeoutMs: number;

export async function activate(context: vscode.ExtensionContext) {
  const rawVersion = vscode.extensions.getExtension('prog76.vscode-mcp-extension')?.packageJSON.version;
  const extensionVersion = typeof rawVersion === 'number' ? String(rawVersion) : (rawVersion || 'unknown');
  log(`Extension activating (v${extensionVersion})`);

  workspace = vscode.workspace.name ||
    vscode.workspace.workspaceFolders?.[0]?.name ||
    'default';

  const config = vscode.workspace.getConfiguration('vscode-mcp');
  mode = config.get<'auto' | 'client-only'>('mode', 'auto');
  terminalEngine = config.get<'auto' | 'force-fallback'>('terminalEngine', 'auto');
  host = config.get<string>('host', CONFIG_DEFAULTS.host);
  port = config.get<number>('port', CONFIG_DEFAULTS.port);

  terminalManager = new TerminalManager(config.get<number>('outputBufferLines', CONFIG_DEFAULTS.outputBufferLines));
  ptyManager = new PtyTerminalManager(config.get<number>('outputBufferLines', CONFIG_DEFAULTS.outputBufferLines));
  satelliteTimeoutMs = getSatelliteTimeoutMs();

  // Align LEFT (priority 3000). The right side of the status bar is heavily
  // crowded (GitLens, Claude Dev/Cline, Quick Command Buttons, Action Buttons,
  // plus VS Code built-ins like the remote indicator, bell, and language), so a
  // right-aligned item gets dropped when space runs out even at priority 3000.
  // The left side is almost always empty, guaranteeing the icon is visible.
  statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    3000
  );
  context.subscriptions.push(statusBar);
  statusBar.command = 'vscode-mcp.statusBarClick';

  // Defensive: re-show after activation so a transient hide during the
  // connection flow can't leave the icon permanently hidden.
  setTimeout(() => {
    if (statusBar) statusBar.show();
  }, 1000);

  // Re-evaluate visibility whenever settings change (e.g. toggling vscode-mcp.showStatus)
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('vscode-mcp')) {
        updateStatusBar();
      }
    })
  );

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
    }),
    vscode.commands.registerCommand('vscode-mcp.forceShowStatusBar', () => {
      if (!statusBar) {
        statusBar = vscode.window.createStatusBarItem(
          vscode.StatusBarAlignment.Left,
          3000
        );
        statusBar.command = 'vscode-mcp.statusBarClick';
      }
      updateStatusBar();
      statusBar.show();
      vscode.window.showInformationMessage('VS Code MCP: Status bar item shown.');
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
  try {
    while (state === 'connecting') {
      try {
        await tryConnect();
        // Successful connect: stamp when the connection went live so a later
        // drop can tell a stable run (reset backoff) from a flap (keep growing).
        lastConnectedAtMs = Date.now();
        return;
      } catch (e) {
        log(`Connection attempt failed: ${e}`);
        // Back off before the next attempt. On a flapping link this delay
        // grows instead of spinning immediately, avoiding hub churn
        // ("Replacing existing satellite connection").
        await new Promise((r) => setTimeout(r, reconnectDelayMs));
        reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_MS);
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

  // No router → try to host one
  try {
    await becomeRouter();
    return;
  } catch (e) {
    // Port already in use (race condition - someone else became the router first)
    log(`Failed to become router (${e}), trying satellite`);
    await connectAsSatellite();
  }
}

async function becomeRouter(): Promise<void> {
  if (!agentServer) return;
  // Stop any satellite connection first so we don't reconnect to the router we're about to host.
  agentServer.stop();

  // The embedded router replaces the old HubServer: same MCP facade (HTTP
  // JSON-RPC at /mcp), same satellite WS intake (/ws, frozen protocol), plus
  // stdio upstreams from config. The vscode toolset is an in-process backend
  // that IS this workspace's session — exactly how the hub served its own
  // window; dial-in windows are the 'windows' ws backend.
  const { router, facade } = await createRouter({
    port,
    host,
    callTimeoutMs: getSatelliteTimeoutMs(),
    progressRearmMs: getTerminalRunTimeoutMs(),
    backends: [{ name: 'windows', transport: 'ws', scope: 'per-session', wsPath: '/ws' }],
  });
  await router.addEmbeddedBackend('vscode', {
    listTools: async () => TOOLS as unknown as import('mcp-router').ToolDescriptor[],
    callTool: async (_sessionId, name, args) => (await agentServer!.callTool(name, args)) as unknown as import('mcp-router').ToolResult,
  }, { sessionId: workspace });
  routerHost = { router, facade };
  setState('connected');
  log(`Router listening at http://${host}:${port} (embedded backend session: "${workspace}")`);
  vscode.window.showInformationMessage(
    `VS Code MCP: Router started (session: "${workspace}") listening at http://${host}:${port}`
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
      // Only reset the backoff after a stable run; a rapidly flapping link
      // keeps the delay growing so it does not storm the hub.
      if (lastConnectedAtMs && Date.now() - lastConnectedAtMs >= STABLE_CONNECTED_MS) {
        reconnectDelayMs = RECONNECT_BASE_MS;
      }
      const delay = reconnectDelayMs;
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_MS);
      // Schedule (not immediate): the hub just saw this satellite drop, so an
      // instant re-register would churn it with "Replacing existing satellite
      // connection". Coalesce rapid drops onto a single pending timer.
      stopReconnectTimer();
      log(`Hub lost, reconnecting in ${delay}ms`);
      vscode.window.showWarningMessage(`VS Code MCP: Hub lost, reconnecting in ${Math.round(delay / 1000)}s...`);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void retryConnection();
      }, delay);
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
  // Explicit disconnect: clean slate for the next (manual) connect.
  reconnectDelayMs = RECONNECT_BASE_MS;
  lastConnectedAtMs = 0;
  const host = routerHost;
  routerHost = undefined;
  if (host) await host.facade.close().catch(() => undefined);
  agentServer?.stop();
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
  log(`updateStatusBar: showStatus=${showStatus} state=${state} router=${routerHost ? 'yes' : 'no'}`);
  if (!showStatus) { statusBar.hide(); return; }
  statusBar.show();

  log(`updateStatusBar: state=${state} router=${routerHost ? 'yes' : 'no'}`);

  switch (state) {
    case 'connecting':
      statusBar.text = '$(loading~spin) MCP';
      statusBar.color = new vscode.ThemeColor('statusBar.foreground');
      statusBar.tooltip = `VS Code MCP Connecting...\nSession: "${workspace}"\nClick to show status`;
      break;
    case 'connected':
      if (routerHost) {
        const sessions = routerHost.router.sessions().filter((s) => s !== workspace).length;
        statusBar.text = sessions > 0 ? `$(plug) MCP ${sessions}` : '$(plug) MCP';
        statusBar.tooltip = `VS Code MCP Router — session "${workspace}" listening at http://${host}:${port}\nSatellites: ${sessions}\nEngine: ${terminalEngine}\nClick to show status`;
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