"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.initLoggerFile = initLoggerFile;
exports.log = log;
/** Standalone logger: mirrors extension/src/logger.ts, writes to stdout + file. */
let filePath = null;
function initLoggerFile(path) {
    filePath = path;
}
function log(message) {
    const ts = new Date().toISOString();
    const line = `[${ts}] ${message}`;
    console.log(`[vscode-mcp-agent] ${message}`);
    if (filePath) {
        try {
            require('fs').appendFileSync(filePath, line + '\n');
        }
        catch { /* noop */ }
    }
}
//# sourceMappingURL=logger.js.map