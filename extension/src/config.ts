import * as vscode from 'vscode';

/**
 * Typed mirrors of contributes.configuration defaults in package.json.
 * Keep these values identical to package.json — that file is the source of truth.
 */
export const CONFIG_DEFAULTS = {
    host: '127.0.0.1',
    port: 27681,
    outputBufferLines: 2000,
    satelliteTimeoutMs: 300000,
    terminalRunTimeoutMs: 300000,
    terminalWaitTimeoutMs: 300000,
    shellReadDrainMs: 500,
    shellStartBindMs: 5000,
    terminalCreateWarmupMs: 5000,
} as const;

function mcpConfig(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('vscode-mcp');
}

export function getTerminalRunTimeoutMs(): number {
    return mcpConfig().get<number>('terminalRunTimeoutMs', CONFIG_DEFAULTS.terminalRunTimeoutMs);
}

export function getTerminalWaitTimeoutMs(): number {
    return mcpConfig().get<number>('terminalWaitTimeoutMs', CONFIG_DEFAULTS.terminalWaitTimeoutMs);
}

export function getSatelliteTimeoutMs(): number {
    return mcpConfig().get<number>('satelliteTimeoutMs', CONFIG_DEFAULTS.satelliteTimeoutMs);
}

export function getShellReadDrainMs(): number {
    return mcpConfig().get<number>('shellReadDrainMs', CONFIG_DEFAULTS.shellReadDrainMs);
}

export function getShellStartBindMs(): number {
    return mcpConfig().get<number>('shellStartBindMs', CONFIG_DEFAULTS.shellStartBindMs);
}

export function getTerminalCreateWarmupMs(): number {
    return mcpConfig().get<number>('terminalCreateWarmupMs', CONFIG_DEFAULTS.terminalCreateWarmupMs);
}
