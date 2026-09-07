"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CONFIG_DEFAULTS = void 0;
exports.setConfigOverrides = setConfigOverrides;
exports.getTerminalRunTimeoutMs = getTerminalRunTimeoutMs;
exports.getTerminalWaitTimeoutMs = getTerminalWaitTimeoutMs;
exports.getSatelliteTimeoutMs = getSatelliteTimeoutMs;
exports.getShellReadDrainMs = getShellReadDrainMs;
exports.getShellStartBindMs = getShellStartBindMs;
exports.getTerminalCreateWarmupMs = getTerminalCreateWarmupMs;
exports.getMaxOutputBytes = getMaxOutputBytes;
/**
 * Standalone config: same defaults as extension/src/config.ts (which mirrors
 * package.json contributes.configuration), resolved from CLI args / env vars
 * instead of VS Code settings.
 */
exports.CONFIG_DEFAULTS = {
    host: '127.0.0.1',
    port: 27681,
    outputBufferLines: 2000,
    satelliteTimeoutMs: 300000,
    terminalRunTimeoutMs: 300000,
    terminalWaitTimeoutMs: 300000,
    shellReadDrainMs: 500,
    shellStartBindMs: 5000,
    terminalCreateWarmupMs: 5000,
    maxOutputBytes: 50000,
};
let overrides = {};
function setConfigOverrides(o) {
    overrides = o;
}
function get(key) {
    return overrides[key] ?? exports.CONFIG_DEFAULTS[key];
}
function getTerminalRunTimeoutMs() { return get('terminalRunTimeoutMs'); }
function getTerminalWaitTimeoutMs() { return get('terminalWaitTimeoutMs'); }
function getSatelliteTimeoutMs() { return get('satelliteTimeoutMs'); }
function getShellReadDrainMs() { return get('shellReadDrainMs'); }
function getShellStartBindMs() { return get('shellStartBindMs'); }
function getTerminalCreateWarmupMs() { return get('terminalCreateWarmupMs'); }
function getMaxOutputBytes() { return get('maxOutputBytes'); }
//# sourceMappingURL=config.js.map