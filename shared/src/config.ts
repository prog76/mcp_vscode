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
    maxOutputBytes: 250_000,
    /**
     * Action when max_output_bytes is exceeded during execute / terminal_run:
     * - "kill": SIGTERM the process (current default behavior)
     * - "stop-capturing": stop buffering output but let the process continue running
     */
    maxOutputBytesAction: 'kill',
    /** Interval (ms) at which progress notifications are sent during long-running tool executions */
    progressReportIntervalMs: 10000,
    /** Whether to reset the tool-call deadline when output progress is reported */
    timeoutRearmOnProgress: true,
} as const;
