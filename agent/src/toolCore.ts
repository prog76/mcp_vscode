import * as fs from 'fs';
import * as path from 'path';
import { spawn, SpawnOptions } from 'child_process';
import { TOOLS } from '@vscode-mcp/shared/toolsSchema';
import { CommandResult, TerminalInfo } from '@vscode-mcp/shared/types';
import { PtyTerminalManager } from './ptyEngine';
import {
    getTerminalRunTimeoutMs,
    getTerminalWaitTimeoutMs,
    getMaxOutputBytes,
} from './config';
import { log } from './logger';

export interface ToolResult {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
}

export { TOOLS };

const NOT_IMPL = (tool: string): string =>
    `${tool} is not implemented in the standalone vscode-mcp-agent (no VS Code window attached). ` +
    `Use a VS Code window session for this tool.`;

/**
 * Standalone twin of the extension's ServerlessServer. Same callTool contract,
 * same TOOLS schema; terminal tools run on the local pty engine, IDE/debug
 * tools return a clear not-implemented error.
 */
export class ToolCore {
    private ptyManager: PtyTerminalManager;
    private sessionId: string;
    private defaultCwd: string;
    private version: string;

    constructor(sessionId: string, defaultCwd: string, version: string) {
        this.ptyManager = new PtyTerminalManager();
        this.sessionId = sessionId;
        this.defaultCwd = defaultCwd;
        this.version = version;
    }

    dispose(): void {
        this.ptyManager.dispose();
    }

    async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
        log(`[agent] callTool start: name="${name}"`);
        const started = Date.now();
        try {
            const result = await this.invokeTool(name, args);
            const raw = result.content?.[0]?.text ?? '';
            const preview = raw.replace(/\s+/g, ' ').slice(0, 160);
            log(
                `[agent] callTool done: name="${name}" durationMs=${Date.now() - started}` +
                (preview ? ` preview="${preview}${raw.length > 160 ? '…' : ''}"` : '')
            );
            return result;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            log(`[agent] callTool done: name="${name}" durationMs=${Date.now() - started} error=${message}`);
            // Return as tool text so hub/MCP clients surface the message instead of
            // a JSON-RPC error wrapped as ExceptionGroup / TaskGroup junk.
            return { content: [{ type: 'text', text: message }], isError: true, structuredContent: { tool: name, ok: false, error: message } };
        }
    }

    private async invokeTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
        const text = (s: string, isError = false): ToolResult => ({
            content: [{ type: 'text', text: s }],
            ...(isError ? { isError: true } : {}),
        });
        const structured = (
            s: string,
            data: Record<string, unknown>,
            isError = false,
        ): ToolResult => ({
            content: [{ type: 'text', text: s }],
            structuredContent: data,
            ...(isError ? { isError: true } : {}),
        });

        switch (name) {
            case 'get_version': {
                return structured(`vscode-mcp-agent (standalone) version: ${this.version}`, { tool: 'get_version', version: this.version });
            }

            case 'terminal_list_sessions': {
                log(`[agent] terminal_list_sessions: session="${this.sessionId}"`);
                return structured(`[hub] session="${this.sessionId}"`, { sessions: [this.sessionId] });
            }

            case 'terminal_list': {
                log(`[agent] terminal_list: session="${this.sessionId}"`);
                const terminals = this.ptyManager.listTerminals();
                if (terminals.length === 0) return structured('No terminals created via terminal_create.', { tool: 'terminal_list', terminals: [] });
                const lines = terminals.map(
                    (t) =>
                        `[${t.id}] "${t.name}"${t.isActive ? ' (active)' : ''}${t.hasShellIntegration ? ' [shell-integration]' : ' [no shell-integration]'}`
                );
                const structuredT = terminals.map((t) => ({
                    id: t.id,
                    name: t.name,
                    is_active: t.isActive,
                    has_shell_integration: t.hasShellIntegration,
                    engine: t.engine,
                }));
                return structured(lines.join('\n'), { tool: 'terminal_list', terminals: structuredT });
            }

            case 'terminal_run': {
                log(`[agent] terminal_run: command="${args.command}" session="${this.sessionId}"`);
                const command = args.command as string;
                const terminalName = args.terminal_name as string | undefined;
                const wait = (args.wait as boolean | undefined) ?? true;
                const timeoutMs =
                    (args.timeout_ms as number | undefined) ?? getTerminalRunTimeoutMs();
                const stdin = args.stdin as string | undefined;
                if (stdin) {
                    this.ptyManager.sendText(command, terminalName, true);
                    await new Promise((r) => setTimeout(r, 100));
                    this.ptyManager.sendText(stdin, terminalName, true);
                    return structured(`Command sent with stdin. Use terminal_wait to retrieve output.`, { tool: 'terminal_run', terminal_name: terminalName ?? null, sent: true, wait_for: 'terminal_wait' });
                }
                if (!wait) {
                    const result = await this.ptyManager.startBackgroundExecution(command, terminalName);
                    return structured(result.message, { tool: 'terminal_run', terminal_name: result.terminalName, started: true, wait: false });
                }
                const result = await this.ptyManager.executeCommand(command, terminalName, timeoutMs);
                return structured(this.formatCommandResult(result), this.commandResultStructured(result));
            }

            case 'terminal_create': {
                log(`[agent] terminal_create: name_prefix="${args.name_prefix}" session="${this.sessionId}"`);
                const prefix = args.name_prefix as string;
                const cwd = (args.cwd as string | undefined) || this.defaultCwd;
                const shell = args.shell as string | undefined;
                const name = this.nextUniqueName(prefix);
                const result = this.ptyManager.createTerminal(name, cwd, shell);
                return structured(`Created terminal "${result.terminalName}" (engine: ${result.engine})`, {
                    tool: 'terminal_create',
                    terminal_name: result.terminalName,
                    engine: result.engine,
                });
            }

            case 'terminal_send_text': {
                const rawText = args.text as string;
                const processed = rawText
                    .replace(/\\x03/g, '\x03')
                    .replace(/\\x04/g, '\x04')
                    .replace(/\\n/g, '\n');
                const terminalName = args.terminal_name as string | undefined;
                const addNewline = (args.add_newline as boolean | undefined) ?? true;
                this.ptyManager.sendText(processed, terminalName, addNewline);
                return text(`Text sent to terminal${terminalName ? ` "${terminalName}"` : ''}.`);
            }

            case 'terminal_read_output': {
                const terminalName = args.terminal_name as string | undefined;
                const lines = args.lines as number | undefined;
                const output = this.ptyManager.readOutput(terminalName, lines);
                return structured(output, { tool: 'terminal_read_output', terminal_name: terminalName ?? null, lines: lines ?? null, output });
            }

            case 'terminal_clear_buffer': {
                const terminalName = args.terminal_name as string | undefined;
                this.ptyManager.clearBuffer(terminalName);
                return structured('Buffer cleared.', { tool: 'terminal_clear_buffer', terminal_name: terminalName ?? null, cleared: true });
            }

            case 'terminal_wait': {
                const terminalName = args.terminal_name as string | undefined;
                if (!terminalName) {
                    throw new Error("terminal_wait requires 'terminal_name'.");
                }
                const timeoutMs =
                    (args.timeout_ms as number | undefined) ?? getTerminalWaitTimeoutMs();
                const result = await this.ptyManager.waitForExecution(terminalName, timeoutMs);
                return structured(this.formatCommandResult(result), this.commandResultStructured(result));
            }

            case 'execute': {
                log(`[agent] execute: command="${args.command}" session="${this.sessionId}"`);
                const command = args.command as string;
                if (!command) {
                    throw new Error("Parameter 'command' is required for execute.");
                }
                const stdin = args.stdin as string | undefined;
                const cwd = (args.cwd as string | undefined) || this.defaultCwd;
                const timeoutMs =
                    (args.timeout_ms as number | undefined) ?? getTerminalRunTimeoutMs();
                const env = args.env as Record<string, string> | undefined;
                const maxOutputBytes =
                    (args.max_output_bytes as number | undefined) ?? getMaxOutputBytes();
                const result = await this.directExecute(command, stdin, timeoutMs, cwd, env, maxOutputBytes);
                return structured(this.formatDirectResult(result), this.commandResultStructured(result));
            }

            case 'get_diagnostics':
            case 'get_document_symbols':
            case 'get_references':
            case 'rename_symbol':
            case 'run_command':
            case 'open_file':
            case 'format_document':
            case 'organize_imports':
            case 'fix_all':
            case 'save_all':
            case 'find_in_files':
            case 'get_hover_info':
            case 'debug_breakpoints':
            case 'debug_start':
            case 'debug_stop':
            case 'debug_state':
            case 'debug_control':
            case 'debug_console_output':
                return text(NOT_IMPL(name), true);

            default:
                throw new Error(`Unknown tool: ${name}`);
        }
    }

    /** Compute a unique terminal name from a prefix (prefix, prefix_1, prefix_2, ...). */
    private nextUniqueName(prefix: string): string {
        if (!this.ptyManager.hasTerminal(prefix)) {
            return prefix;
        }
        let i = 1;
        while (this.ptyManager.hasTerminal(`${prefix}_${i}`)) {
            i++;
        }
        return `${prefix}_${i}`;
    }

    private formatCommandResult(result: CommandResult): string {
        let response = result.output || '(no output)';
        if (result.exitCode !== undefined) {
            response += `\n[exit code: ${result.exitCode}]`;
        }
        return response;
    }

    private commandResultStructured(result: CommandResult): Record<string, unknown> {
        const ok =
            result.exitCode === undefined
                ? !result.timedOut
                : result.exitCode === 0;
        return {
            ok,
            exit_code: result.exitCode ?? null,
            stdout: result.output === '(no output)' ? '' : (result.output || ''),
            stderr: result.stderr || '',
            timed_out: !!result.timedOut,
            truncated: !!result.truncated,
            timeout_ms: result.timeoutMs ?? null,
        };
    }

    private async directExecute(
        command: string,
        stdin: string | undefined,
        timeoutMs: number,
        cwd: string | undefined,
        env: Record<string, string> | undefined,
        maxOutputBytes: number
    ): Promise<CommandResult> {
        const resolvedCwd = cwd || this.defaultCwd || process.cwd();
        const resolvedEnv = { ...process.env, ...(env ?? {}) };

        return new Promise<CommandResult>((resolve) => {
            let stdout = '';
            let stderr = '';
            let resolved = false;
            let truncated = false;

            const options: SpawnOptions = {
                shell: true,
                cwd: resolvedCwd,
                env: resolvedEnv,
                stdio: ['pipe', 'pipe', 'pipe'],
            };

            const child = spawn(command, [], options);

            const onData = (buf: Buffer) => {
                stdout += buf.toString();
                if (stdout.length + stderr.length > maxOutputBytes) {
                    truncated = true;
                    child.kill('SIGTERM');
                }
            };
            const onErr = (buf: Buffer) => {
                stderr += buf.toString();
                if (stdout.length + stderr.length > maxOutputBytes) {
                    truncated = true;
                    child.kill('SIGTERM');
                }
            };

            child.stdout?.on('data', onData);
            child.stderr?.on('data', onErr);

            if (stdin !== undefined) {
                child.stdin?.write(stdin, (err) => {
                    if (err) {
                        log(`[execute] stdin write error: ${err}`);
                    }
                });
            }
            child.stdin?.end();

            const timer = setTimeout(() => {
                if (resolved) return;
                log(
                    `[execute] timeout cwd="${resolvedCwd}" command="${command.slice(0, 120)}" ` +
                    `timeoutMs=${timeoutMs} stdoutChars=${stdout.length}`
                );
                child.kill('SIGTERM');
                setTimeout(() => {
                    if (child.exitCode === null) {
                        child.kill('SIGKILL');
                    }
                }, 3000);
                resolved = true;
                clearTimeout(timer);
                resolve({
                    output: stdout || '(no output)',
                    exitCode: undefined,
                    timedOut: true,
                    stderr,
                    timeoutMs,
                    truncated,
                    maxOutputBytes,
                });
            }, timeoutMs);

            child.on('error', (err: Error) => {
                if (resolved) return;
                resolved = true;
                clearTimeout(timer);
                log(`[execute] spawn error: ${err}`);
                resolve({
                    output: `(execute error) ${err.message}`,
                    exitCode: undefined,
                    timedOut: false,
                    stderr: '',
                    truncated,
                    maxOutputBytes,
                });
            });

            child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
                if (resolved) return;
                resolved = true;
                clearTimeout(timer);
                log(
                    `[execute] close code=${code} signal=${signal} ` +
                    `stdoutChars=${stdout.length} stderrChars=${stderr.length}`
                );
                resolve({
                    output: stdout,
                    exitCode: code ?? undefined,
                    timedOut: false,
                    stderr,
                    timeoutMs,
                    truncated,
                    maxOutputBytes,
                });
            });
        });
    }

    private formatDirectResult(result: CommandResult): string {
        if (result.timedOut) {
            const secs = result.timeoutMs ? Math.round(result.timeoutMs / 1000) : 0;
            let msg = '';
            if (result.output) {
                msg += result.output;
            }
            if (result.stderr) {
                msg += `\n--- stderr ---\n${result.stderr}`;
            }
            if (!msg.trim()) {
                msg = '(no output)';
            }
            return `${msg}\n\n[STILL RUNNING — timed out after ${secs}s, process killed, no exit code.]`;
        }

        let response = result.output || '';
        if (result.stderr) {
            response += `\n--- stderr ---\n${result.stderr}`;
        }
        if (result.exitCode !== undefined) {
            response += `\n[exit code: ${result.exitCode}]`;
        }
        if (result.truncated) {
            const kb = Math.round((result.maxOutputBytes ?? 0) / 1024);
            response += `\n[output truncated at ${result.maxOutputBytes} bytes (~${kb} KB) — use terminal_run to see more]`;
        }
        return response;
    }
}
