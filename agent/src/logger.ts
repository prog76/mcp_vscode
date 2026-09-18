/** Standalone logger: mirrors extension/src/logger.ts, writes to stdout + file. */
let filePath: string | null = null;
/** stdio mode must keep stdout clean for the MCP protocol; route logs to stderr. */
let quietStdout = false;

export function initLoggerFile(path: string | null): void {
    filePath = path;
}

/** In stdio mode stdout is the MCP transport — never write logs to it. */
export function setStdioQuiet(): void {
    quietStdout = true;
}

export function log(message: string): void {
    const ts = new Date().toISOString();
    const line = `[${ts}] ${message}`;
    if (!quietStdout) console.log(`[vscode-mcp-agent] ${message}`);
    else console.error(`[vscode-mcp-agent] ${message}`);
    if (filePath) {
        try { require('fs').appendFileSync(filePath, line + '\n'); } catch { /* noop */ }
    }
}
