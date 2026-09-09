/** Standalone logger: mirrors extension/src/logger.ts, writes to stdout + file. */
let filePath: string | null = null;

export function initLoggerFile(path: string | null): void {
    filePath = path;
}

export function log(message: string): void {
    const ts = new Date().toISOString();
    const line = `[${ts}] ${message}`;
    console.log(`[vscode-mcp-agent] ${message}`);
    if (filePath) {
        try { require('fs').appendFileSync(filePath, line + '\n'); } catch { /* noop */ }
    }
}
