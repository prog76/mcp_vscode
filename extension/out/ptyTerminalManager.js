"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.PtyTerminalManager = void 0;
const vscode = __importStar(require("vscode"));
/**
 * Fallback terminal engine using node-pty. Used when shell integration is
 * unavailable (e.g. ash/Alpine shells) or when terminalEngine=force-fallback.
 * Provides a persistent shell per terminal so cd/env state persists.
 */
class PtyTerminalManager {
    constructor() {
        this.terminals = new Map();
    }
    listTerminals() {
        const active = vscode.window.activeTerminal;
        return Array.from(this.terminals.values()).map((t, i) => ({
            id: i,
            name: t.name,
            isActive: t.terminal === active,
            hasShellIntegration: false,
            engine: 'pty-fallback',
        }));
    }
    async executeCommand(command, terminalName, timeoutMs = 300000) {
        const term = this.getOrCreateTerminal(terminalName);
        term.terminal.sendText(command + '\r');
        // Wait a short time for output to accumulate, then read the buffer.
        const started = Date.now();
        const deadline = started + Math.min(timeoutMs, 30000);
        while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 200));
            const output = term.outputBuffer.join('');
            if (output.includes('$') && output.trim().length > 0) {
                break;
            }
        }
        const output = term.outputBuffer.join('');
        return {
            output: output || '(no output)',
            exitCode: undefined,
            timedOut: false,
        };
    }
    async startBackgroundExecution(command, terminalName) {
        const term = this.getOrCreateTerminal(terminalName);
        term.terminal.sendText(command + '\r');
        return {
            terminalName: term.name,
            message: `Command started in terminal '${term.name}': ${command}\nUse terminal_wait to retrieve output.`,
        };
    }
    async waitForExecution(terminalName, timeoutMs = 300000) {
        const term = this.terminals.get(terminalName);
        if (!term) {
            throw new Error(`Terminal '${terminalName}' not found.`);
        }
        const started = Date.now();
        const deadline = started + Math.min(timeoutMs, 30000);
        while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 200));
            const output = term.outputBuffer.join('');
            if (output.includes('$') && output.trim().length > 0) {
                break;
            }
        }
        const output = term.outputBuffer.join('');
        return {
            output: output || '(no output)',
            exitCode: undefined,
            timedOut: false,
        };
    }
    createTerminal(name, cwd, shell) {
        const resolved = shell || 'bash';
        const terminal = vscode.window.createTerminal({ name, cwd: cwd ? vscode.Uri.file(cwd) : undefined, shellPath: resolved });
        terminal.show(true);
        return { terminalName: terminal.name, engine: 'pty-fallback' };
    }
    sendText(text, terminalName, addNewline = true) {
        const term = this.getOrCreateTerminal(terminalName);
        term.terminal.sendText(text, addNewline);
        return term.name;
    }
    readOutput(terminalName, lines) {
        let term;
        if (terminalName) {
            term = this.terminals.get(terminalName);
            if (!term) {
                throw new Error(`Terminal "${terminalName}" not found.`);
            }
        }
        else {
            term = Array.from(this.terminals.values())[this.terminals.size - 1];
            if (!term)
                throw new Error('No terminals open');
        }
        const all = term.outputBuffer.join('');
        if (lines !== undefined) {
            const parts = all.split('\n');
            return parts.slice(-lines).join('\n');
        }
        return all;
    }
    clearBuffer(terminalName) {
        if (terminalName) {
            const term = this.terminals.get(terminalName);
            if (term)
                term.outputBuffer = [];
        }
        else {
            const term = Array.from(this.terminals.values())[this.terminals.size - 1];
            if (term)
                term.outputBuffer = [];
        }
    }
    getOrCreateTerminal(name) {
        if (name) {
            const existing = this.terminals.get(name);
            if (existing)
                return existing;
        }
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
        const terminalName = name || 'MCP Terminal';
        const writeEmitter = new vscode.EventEmitter();
        const closeEmitter = new vscode.EventEmitter();
        let inputBuffer = '';
        let termInfo;
        const terminal = vscode.window.createTerminal({
            name: terminalName,
            pty: {
                onDidWrite: writeEmitter.event,
                onDidClose: closeEmitter.event,
                open: () => {
                    writeEmitter.fire(`\x1b[1;32mMCP Terminal (${cwd})\x1b[0m\r\n`);
                },
                close: () => {
                    closeEmitter.fire();
                },
                handleInput: (data) => {
                    inputBuffer += data;
                    const idx = inputBuffer.indexOf('\r');
                    if (idx >= 0) {
                        const full = inputBuffer.slice(0, idx);
                        inputBuffer = inputBuffer.slice(idx + 1);
                        const command = full.replace(/[\x00-\x1f\x7f]/g, '').trim();
                        if (command) {
                            this.writeCommandToShell(command, termInfo);
                        }
                    }
                }
            }
        });
        const id = name || this.generateId();
        termInfo = {
            id,
            name: terminalName,
            terminal,
            outputBuffer: [],
            cwd,
            writeEmitter,
            closeEmitter
        };
        // Spawn a single persistent shell using node-pty
        const pty = require('node-pty');
        const shellPath = process.platform === 'win32' ? 'cmd.exe' : (process.env.SHELL || '/bin/sh');
        const shellProcess = pty.spawn(shellPath, [], {
            cwd,
            name: 'xterm-256color',
            cols: 80,
            rows: 24
        });
        termInfo.shellProcess = shellProcess;
        shellProcess.onData((data) => {
            termInfo.outputBuffer.push(data);
            writeEmitter.fire(data);
        });
        this.terminals.set(id, termInfo);
        terminal.show();
        return termInfo;
    }
    writeCommandToShell(command, termInfo) {
        const shell = termInfo.shellProcess;
        if (!shell) {
            console.error('Shell process not available');
            return;
        }
        const echo = `$ ${command}\r\n`;
        termInfo.outputBuffer.push(echo);
        termInfo.writeEmitter.fire(echo);
        shell.write(command + '\n');
    }
    generateId() {
        return Math.random().toString(36).substring(2, 15) +
            Math.random().toString(36).substring(2, 15);
    }
    dispose() {
        for (const term of this.terminals.values()) {
            if (term.shellProcess) {
                term.shellProcess.kill();
            }
            term.terminal.dispose();
        }
        this.terminals.clear();
    }
}
exports.PtyTerminalManager = PtyTerminalManager;
//# sourceMappingURL=ptyTerminalManager.js.map