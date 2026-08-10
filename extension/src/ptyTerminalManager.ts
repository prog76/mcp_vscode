import * as vscode from 'vscode';
import { CommandResult, TerminalInfo } from './terminalManager';

interface PtyTerminalInfo {
    id: string;
    name: string;
    terminal: vscode.Terminal;
    outputBuffer: string[];
    cwd: string;
    writeEmitter: vscode.EventEmitter<string>;
    closeEmitter: vscode.EventEmitter<void>;
    shellProcess?: any;
}

/**
 * Fallback terminal engine using node-pty. Used when shell integration is
 * unavailable (e.g. ash/Alpine shells) or when terminalEngine=force-fallback.
 * Provides a persistent shell per terminal so cd/env state persists.
 */
export class PtyTerminalManager {
    private terminals = new Map<string, PtyTerminalInfo>();

    listTerminals(): TerminalInfo[] {
        const active = vscode.window.activeTerminal;
        return Array.from(this.terminals.values()).map((t, i) => ({
            id: i,
            name: t.name,
            isActive: t.terminal === active,
            hasShellIntegration: false,
            engine: 'pty-fallback' as const,
        }));
    }

    async executeCommand(
        command: string,
        terminalName?: string,
        timeoutMs = 300_000
    ): Promise<CommandResult> {
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

    async startBackgroundExecution(
        command: string,
        terminalName?: string
    ): Promise<{ terminalName: string; message: string }> {
        const term = this.getOrCreateTerminal(terminalName);
        term.terminal.sendText(command + '\r');
        return {
            terminalName: term.name,
            message: `Command started in terminal '${term.name}': ${command}\nUse terminal_wait to retrieve output.`,
        };
    }

    async waitForExecution(
        terminalName: string,
        timeoutMs = 300_000
    ): Promise<CommandResult & { fromCache?: boolean; cacheAgeMs?: number }> {
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

    createTerminal(name: string, cwd?: string, shell?: string): { terminalName: string; engine: 'pty-fallback' } {
        const resolved = shell || 'bash';
        const terminal = vscode.window.createTerminal({ name, cwd: cwd ? vscode.Uri.file(cwd) : undefined, shellPath: resolved });
        terminal.show(true);
        return { terminalName: terminal.name, engine: 'pty-fallback' };
    }

    sendText(text: string, terminalName?: string, addNewline = true): string {
        const term = this.getOrCreateTerminal(terminalName);
        term.terminal.sendText(text, addNewline);
        return term.name;
    }

    readOutput(terminalName?: string, lines?: number): string {
        let term: PtyTerminalInfo | undefined;
        if (terminalName) {
            term = this.terminals.get(terminalName);
            if (!term) {
                throw new Error(`Terminal "${terminalName}" not found.`);
            }
        } else {
            term = Array.from(this.terminals.values())[this.terminals.size - 1];
            if (!term) throw new Error('No terminals open');
        }
        const all = term.outputBuffer.join('');
        if (lines !== undefined) {
            const parts = all.split('\n');
            return parts.slice(-lines).join('\n');
        }
        return all;
    }

    clearBuffer(terminalName?: string): void {
        if (terminalName) {
            const term = this.terminals.get(terminalName);
            if (term) term.outputBuffer = [];
        } else {
            const term = Array.from(this.terminals.values())[this.terminals.size - 1];
            if (term) term.outputBuffer = [];
        }
    }

    private getOrCreateTerminal(name?: string): PtyTerminalInfo {
        if (name) {
            const existing = this.terminals.get(name);
            if (existing) return existing;
        }
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
        const terminalName = name || 'MCP Terminal';

        const writeEmitter = new vscode.EventEmitter<string>();
        const closeEmitter = new vscode.EventEmitter<void>();
        let inputBuffer = '';
        let termInfo: PtyTerminalInfo;

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
                handleInput: (data: string) => {
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

        shellProcess.onData((data: string) => {
            termInfo.outputBuffer.push(data);
            writeEmitter.fire(data);
        });

        this.terminals.set(id, termInfo);
        terminal.show();
        return termInfo;
    }

    private writeCommandToShell(command: string, termInfo: PtyTerminalInfo) {
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

    private generateId(): string {
        return Math.random().toString(36).substring(2, 15) +
            Math.random().toString(36).substring(2, 15);
    }

    dispose(): void {
        for (const term of this.terminals.values()) {
            if (term.shellProcess) {
                term.shellProcess.kill();
            }
            term.terminal.dispose();
        }
        this.terminals.clear();
    }
}