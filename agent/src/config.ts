/**
 * Standalone config: same defaults as extension/src/config.ts (which mirrors
 * package.json contributes.configuration), resolved from CLI args / env vars
 * instead of VS Code settings.
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
    maxOutputBytes: 50_000,
} as const;

let overrides: Record<string, number> = {};

export function setConfigOverrides(o: Record<string, number>): void {
    overrides = o;
}

function get(key: keyof typeof CONFIG_DEFAULTS): number {
    return overrides[key] ?? CONFIG_DEFAULTS[key];
}

export function getTerminalRunTimeoutMs(): number { return get('terminalRunTimeoutMs'); }
export function getTerminalWaitTimeoutMs(): number { return get('terminalWaitTimeoutMs'); }
export function getSatelliteTimeoutMs(): number { return get('satelliteTimeoutMs'); }
export function getShellReadDrainMs(): number { return get('shellReadDrainMs'); }
export function getShellStartBindMs(): number { return get('shellStartBindMs'); }
export function getTerminalCreateWarmupMs(): number { return get('terminalCreateWarmupMs'); }
export function getMaxOutputBytes(): number { return get('maxOutputBytes'); }
