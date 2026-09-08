import { TerminalInfo, CommandResult } from '@vscode-mcp/shared/types';
import { log } from './logger';

interface PtyTerminalInfo {
    id: string;
    name: string;
    outputBuffer: string[];
    maxLines: number;
    cwd: string;
    shellProcess: any;
    exited: boolean;
}

/**
 * Standalone terminal engine: a persistent shell per named terminal, spawned
 * directly via node-pty (no VS Code terminal tab). Same external semantics as
 * the extension's engines: cd/env persistence per terminal, buffered output,
 * background execution + wait. Exit codes for commands run in the persistent
 * shell are not captured (same as the extension's pty-fallback engine).
 */
export class PtyTerminalManager {
    private terminals = new Map<string, PtyTerminalInfo>();
    private maxLines: number;

    constructor(maxLines = 2000) {
        this.maxLines = maxLines;
    }

    hasTerminal(name: string): boolean {
        return this.terminals.has(name);
    }

    listTerminals(): TerminalInfo[] {
        return Array.from(this.terminals.values()).map((t) => ({
            id: t.id,
            name: t.name,
            isActive: false,
            hasShellIntegration: false,
            engine: 'pty-fallback' as const,
        }));
    }

    createTerminal(name: string, cwd?: string, shell?: string): { terminalName: string; engine: 'pty-fallback' } {
        this.createPtyTerminal(name, cwd, shell);
        return { terminalName: name, engine: 'pty-fallback' };
    }

    async executeCommand(
        command: string,
        terminalName: string | undefined,
        timeoutMs: number
    ): Promise<CommandResult> {
        const term = this.getOrCreateTerminal(terminalName);
        this.writeCommandToShell(command, term);
        const started = Date.now();
        const deadline = started + Math.min(timeoutMs, 30000);
        let lastLen = 0;
        let stable = 0;
        while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 200));
            const out = term.outputBuffer.join('');
            if (out.length > lastLen) {
                lastLen = out.length;
                stable = 0;
            } else {
                stable++;
            }
            if (stable >= 3) break;
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
        this.writeCommandToShell(command, term);
        return {
            terminalName: term.name,
            message: `Command started in terminal '${term.name}': ${command}\nUse terminal_wait to retrieve output.`,
        };
    }

    async waitForExecution(
        terminalName: string,
        timeoutMs: number
    ): Promise<CommandResult> {
        const term = this.terminals.get(terminalName);
        if (!term) {
            throw new Error(`Terminal '${terminalName}' not found.`);
        }
        const started = Date.now();
        const deadline = started + Math.min(timeoutMs, 30000);
        let lastLen = 0;
        let stable = 0;
        while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 200));
            const out = term.outputBuffer.join('');
            if (out.length > lastLen) {
                lastLen = out.length;
                stable = 0;
            } else {
                stable++;
            }
            if (stable >= 3) break;
        }
        const output = term.outputBuffer.join('');
        return {
            output: output || '(no output)',
            exitCode: undefined,
            timedOut: false,
        };
    }

    sendText(text: string, terminalName?: string, addNewline = true): string {
        const term = this.getOrCreateTerminal(terminalName);
        term.shellProcess.write(text + (addNewline ? '\r' : ''));
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
            const arr = Array.from(this.terminals.values());
            term = arr[arr.length - 1];
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
            for (const term of this.terminals.values()) term.outputBuffer = [];
        }
    }

    private getOrCreateTerminal(name?: string): PtyTerminalInfo {
        if (name) {
            const existing = this.terminals.get(name);
            if (existing) return existing;
        }
        return this.createPtyTerminal(name || 'MCP Terminal', undefined, undefined);
    }

    private createPtyTerminal(name: string, cwd?: string, shell?: string): PtyTerminalInfo {
        const resolvedCwd = cwd || process.cwd();
        // Late-require so the module also loads (for tests/schema import) on hosts without node-pty built.
        const pty = require('node-pty');
        const shellPath = shell || (process.platform === 'win32' ? 'cmd.exe' : (process.env.SHELL || '/bin/sh'));
        const shellProcess = pty.spawn(shellPath, [], {
            cwd: resolvedCwd,
            name: 'xterm-256color',
            cols: 80,
            rows: 24,
            env: process.env as { [key: string]: string },
        });
        const termInfo: PtyTerminalInfo = {
            id: name,
            name,
            outputBuffer: [],
            maxLines: this.maxLines,
            cwd: resolvedCwd,
            shellProcess,
            exited: false,
        };
        shellProcess.onData((data: string) => {
            termInfo.outputBuffer.push(data);
            if (termInfo.outputBuffer.length > termInfo.maxLines) {
                termInfo.outputBuffer.splice(0, termInfo.outputBuffer.length - termInfo.maxLines);
            }
        });
        shellProcess.onExit(() => {
            termInfo.exited = true;
            log(`[pty] shell exited for terminal '${name}'`);
        });
        this.terminals.set(name, termInfo);
        log(`[pty] created terminal '${name}' (shell=${shellPath}, cwd=${resolvedCwd})`);
        return termInfo;
    }

    private writeCommandToShell(command: string, termInfo: PtyTerminalInfo) {
        if (termInfo.exited) {
            throw new Error(`Terminal '${termInfo.name}' shell has exited.`);
        }
        const echo = `$ ${command}\r\n`;
        termInfo.outputBuffer.push(echo);
        termInfo.shellProcess.write(command + '\r');
    }

    dispose(): void {
        for (const term of this.terminals.values()) {
            try { term.shellProcess.kill(); } catch { /* noop */ }
        }
        this.terminals.clear();
    }
}
