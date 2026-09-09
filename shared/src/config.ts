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
