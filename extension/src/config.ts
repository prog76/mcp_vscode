import * as vscode from 'vscode';
import { CONFIG_DEFAULTS as SHARED_DEFAULTS } from '@vscode-mcp/shared/config';

export const CONFIG_DEFAULTS = SHARED_DEFAULTS;

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
export function getMaxOutputBytes(): number {
    return mcpConfig().get<number>('maxOutputBytes', CONFIG_DEFAULTS.maxOutputBytes);
}
