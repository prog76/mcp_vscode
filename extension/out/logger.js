"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.initLogger = initLogger;
exports.log = log;
let outputChannel = null;
function initLogger(channel) {
    outputChannel = channel;
}
function log(message) {
    const ts = new Date().toISOString();
    const line = `[${ts}] ${message}`;
    outputChannel?.appendLine(line);
    console.log(`[VS Code MCP] ${message}`);
}
//# sourceMappingURL=logger.js.map