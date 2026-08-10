"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const terminalManager_1 = require("./terminalManager");
const ptyTerminalManager_1 = require("./ptyTerminalManager");
const serverlessServer_1 = require("./serverlessServer");
const hubServer_1 = require("./hubServer");
const logger_1 = require("./logger");
let workspace;
let statusBar;
let mode = 'auto';
let terminalEngine = 'auto';
let terminalManager;
let ptyManager;
let agentServer;
let hubServer;
let healthCheckTimer = null;
let reconnectTimer = null;
let state = 'disconnected';
const outputChannel = vscode.window.createOutputChannel('VS Code MCP');
(0, logger_1.initLogger)(outputChannel);
let host;
let port;
let satelliteTimeoutMs;
async function activate(context) {
    (0, logger_1.log)('Extension activating');
    workspace = vscode.workspace.name ||
        vscode.workspace.workspaceFolders?.[0]?.name ||
        'default';
    const config = vscode.workspace.getConfiguration('vscode-mcp');
    mode = config.get('mode', 'auto');
    terminalEngine = config.get('terminalEngine', 'auto');
    host = config.get('host', '127.0.0.1');
    port = config.get('port', 27681);
    terminalManager = new terminalManager_1.TerminalManager(config.get('outputBufferLines', 2000));
    ptyManager = new ptyTerminalManager_1.PtyTerminalManager();
    satelliteTimeoutMs = config.get('satelliteTimeoutMs', 120000);
    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    context.subscriptions.push(statusBar);
    statusBar.command = 'vscode-mcp.statusBarClick';
    updateStatusBar();
    statusBar.show();
    context.subscriptions.push(vscode.debug.registerDebugAdapterTrackerFactory('*', {
        createDebugAdapterTracker() {
            return {
                onDidSendMessage(message) {
                    if (message.type === 'event' && message.event === 'output' && message.body?.output) {
                        if (message.body.category !== 'telemetry') {
                            agentServer?.appendDebugOutput(message.body.output, message.body.category);
                        }
                    }
                },
            };
        },
    }));
    context.subscriptions.push(vscode.commands.registerCommand('vscode-mcp.statusBarClick', async () => {
        const items = [];
        items.push({ label: '$(info) Show Connection Status', action: 'status' });
        items.push({ label: '$(terminal) List Managed Terminals', action: 'list-terminals' });
        items.push({ label: '$(copy) Copy Workspace ID', description: `Copy "${workspace}" to clipboard`, action: 'copy-workspace' });
        if (state === 'disconnected') {
            items.push({ label: '$(plug) Connect', action: 'connect' });
        }
        else {
            items.push({ label: '$(debug-disconnect) Disconnect', action: 'disconnect' });
        }
        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'VS Code MCP Extension - Choose action',
            title: 'MCP Connection Management'
        });
        if (!selected)
            return;
        switch (selected.action) {
            case 'status':
                vscode.window.showInformationMessage(`Workspace: ${workspace}\nState: ${state}\nTerminal engine: ${terminalEngine}\nPort: ${port}`);
                break;
            case 'list-terminals':
                const terminalList = terminalManager?.listTerminals() ?? [];
                const message = terminalList.length > 0
                    ? terminalList.map(t => `[${t.id}] "${t.name}"${t.hasShellIntegration ? ' [shell-integration]' : ' [no shell-integration]'}`).join('\n')
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
    }), vscode.commands.registerCommand('vscode-mcp.disconnect', async () => { await disconnect(); }), vscode.commands.registerCommand('vscode-mcp.reconnect', async () => {
        await disconnect();
        setTimeout(() => retryConnection(), 500);
    }), vscode.commands.registerCommand('vscode-mcp.listTerminals', async () => {
        const terminalList = terminalManager?.listTerminals() ?? [];
        const message = terminalList.length > 0
            ? terminalList.map(t => `[${t.id}] "${t.name}"${t.hasShellIntegration ? ' [shell-integration]' : ' [no shell-integration]'}`).join('\n')
            : 'No active terminals';
        vscode.window.showInformationMessage(`Active terminals:\n${message}`);
    }));
    statusBar.tooltip = `VS Code MCP Extension\nClick to show status`;
    (0, logger_1.log)(`Activated for workspace: ${workspace}`);
    if (!terminalManager || !ptyManager)
        return;
    agentServer = new serverlessServer_1.ServerlessServer(terminalManager, ptyManager, workspace, terminalEngine, 2000);
    retryConnection();
}
async function retryConnection() {
    stopReconnectTimer();
    setState('connecting');
    let delay = 1000;
    while (state === 'connecting') {
        try {
            await tryConnect();
            return;
        }
        catch (e) {
            (0, logger_1.log)(`Connection attempt failed: ${e}`);
            await new Promise((r) => setTimeout(r, delay));
            delay = Math.min(delay * 2, 30000);
        }
    }
}
/**
 * Try to connect:
 * 1. If client-only mode → always join existing hub (or fail).
 * 2. In auto mode: try to become the hub by binding the port.
 *    If the port is already in use → join as satellite.
 */
async function tryConnect() {
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
    }
    catch {
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
    }
    catch (e) {
        // Port already in use (race condition - someone else became hub first)
        (0, logger_1.log)(`Failed to become hub (${e}), trying satellite`);
        await connectAsSatellite();
    }
}
async function becomeHub() {
    if (!agentServer)
        return;
    // Stop any satellite connection first so we don't reconnect to the hub we're about to become.
    agentServer.stop();
    const rawVersion = vscode.extensions.getExtension('picoclaw.vscode-mcp-extension')?.packageJSON.version;
    const extensionVersion = typeof rawVersion === 'number' ? String(rawVersion) : (rawVersion || 'unknown');
    hubServer = new hubServer_1.HubServer(agentServer, workspace, extensionVersion, port, host, satelliteTimeoutMs);
    hubServer.onEvent((event) => {
        if (event.type === 'satellite-connected') {
            (0, logger_1.log)(`Satellite connected: ${event.sessionId} (total: ${event.satelliteCount})`);
            vscode.window.showInformationMessage(`VS Code MCP: Satellite "${event.sessionId}" connected (${event.satelliteCount} total)`);
        }
        else {
            (0, logger_1.log)(`Satellite disconnected: ${event.sessionId} (total: ${event.satelliteCount})`);
            vscode.window.showInformationMessage(`VS Code MCP: Satellite "${event.sessionId}" disconnected (${event.satelliteCount} remaining)`);
        }
        updateStatusBar();
    });
    await hubServer.start();
    setState('connected');
    (0, logger_1.log)(`Hub listening at http://${host}:${port}`);
    vscode.window.showInformationMessage(`VS Code MCP: Hub started (session: "${workspace}") listening at http://${host}:${port}`);
}
async function connectAsSatellite() {
    if (!agentServer)
        return;
    const wsUrl = `ws://${host}:${port}/ws`;
    agentServer.onHubLost(() => {
        (0, logger_1.log)('Hub lost callback triggered');
        stopHealthCheck();
        setState('connecting');
        vscode.window.showWarningMessage('VS Code MCP: Hub lost, attempting to reconnect...');
        retryConnection();
    });
    await agentServer.connectAsSatellite(wsUrl);
    setState('connected');
    (0, logger_1.log)(`Connected as satellite to hub at ws://${host}:${port}`);
    vscode.window.showInformationMessage(`VS Code MCP: Connected as satellite to ws://${host}:${port} (session: "${workspace}")`);
    startHealthCheck();
}
async function deactivate() {
    (0, logger_1.log)('Extension deactivating');
    await disconnect();
    outputChannel.dispose();
}
async function disconnect() {
    setState('disconnected');
    stopHealthCheck();
    stopReconnectTimer();
    await hubServer?.stop();
    agentServer?.stop();
    hubServer = undefined;
    updateStatusBar();
}
function setState(newState) {
    if (state !== newState) {
        (0, logger_1.log)(`State change: ${state} → ${newState}`);
        state = newState;
        updateStatusBar();
    }
}
function startHealthCheck() {
    stopHealthCheck();
    let failures = 0;
    healthCheckTimer = setInterval(async () => {
        try {
            const res = await fetch(`http://${host}:${port}/health`);
            if (!res.ok)
                throw new Error(`HTTP ${res.status}`);
            failures = 0;
        }
        catch (e) {
            failures++;
            (0, logger_1.log)(`Health check failed (${failures}/3): ${e}`);
            if (failures >= 3) {
                stopHealthCheck();
                setState('connecting');
                vscode.window.showWarningMessage('VS Code MCP: Hub unreachable, reconnecting...');
                retryConnection();
            }
        }
    }, 10000);
}
function stopHealthCheck() {
    if (healthCheckTimer) {
        clearInterval(healthCheckTimer);
        healthCheckTimer = null;
    }
}
function stopReconnectTimer() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
}
function updateStatusBar() {
    if (!statusBar)
        return;
    const config = vscode.workspace.getConfiguration('vscode-mcp');
    const showStatus = config.get('showStatus', true);
    if (!showStatus) {
        statusBar.hide();
        return;
    }
    statusBar.show();
    (0, logger_1.log)(`updateStatusBar: state=${state} hub=${hubServer ? 'yes' : 'no'}`);
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
            }
            else {
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
//# sourceMappingURL=extension.js.map