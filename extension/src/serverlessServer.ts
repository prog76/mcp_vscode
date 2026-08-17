import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, SpawnOptions } from 'child_process';
import WebSocket from 'ws';
import { TerminalManager, CommandResult } from './terminalManager';
import { PtyTerminalManager } from './ptyTerminalManager';
import { CONFIG_DEFAULTS, getTerminalRunTimeoutMs, getTerminalWaitTimeoutMs, getMaxOutputBytes } from './config';
import { log } from './logger';
import { parseWsMessage, sendMessage, replaceSocket } from './wsProtocol';

export interface ToolResult {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
}

export const TOOLS = [
    {
        name: 'get_version',
        description: 'Get the version of the vscode-mcp extension (read from package.json at runtime).',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'terminal_create',
        description:
            'Create a new terminal explicitly. Use this when you need a fresh terminal with specific settings.\n' +
            'engine=shell uses VS Code shell integration (default). engine=pty uses node-pty fallback.\n' +
            'Takes a name_prefix and returns the created terminal name, which is guaranteed unique: ' +
            'the first terminal gets the prefix as its name (e.g. "build"), subsequent ones get "build_1", "build_2", ...\n' +
            'Pass the returned name to terminal_run as terminal_name. Only terminals created here are listed by terminal_list.',
        inputSchema: {
            type: 'object',
            properties: {
                name_prefix: { type: 'string', description: 'Name prefix. The actual terminal name is this, or name_1, name_2, ... if taken.' },
                cwd: { type: 'string', description: 'Working directory path' },
                engine: { type: 'string', enum: ['auto', 'shell', 'pty'], description: 'Terminal engine (default: auto)' },
                shell: { type: 'string', description: 'Shell executable path/name (optional)' },
                session_id: { type: 'string', description: 'Target session ID (workspace name).' },
            },
            required: ['name_prefix'],
        },
    },
    {
        name: 'terminal_list_sessions',
        description:
            'Lists all connected VS Code windows with their session IDs (= workspace folder name). ' +
            'Identify your session by matching the workspace folder name visible in your current context, ' +
            'then remember that session_id and pass it to all subsequent terminal tool calls.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'terminal_list',
        description:
            'List terminals created via terminal_create in this session. With session_id lists terminals in that session only.\n' +
            'Each entry shows the terminal name and its engine: [shell-integration] or [no shell-integration].\n' +
            'Pass the shown name to terminal_run/terminal_wait as terminal_name. Terminals not created via terminal_create are not listed.',
        inputSchema: {
            type: 'object',
            properties: {
                session_id: { type: 'string', description: 'Target session ID (workspace name).' },
            },
        },
    },
    {
        name: 'terminal_run',
        description:
            'Execute a shell command in a VS Code terminal and capture output.\n' +
            'Blocks until the command finishes or timeout_ms elapses.\n' +
            'Default timeout_ms = vscode-mcp.terminalRunTimeoutMs from extension settings ' +
            `(package.json default ${CONFIG_DEFAULTS.terminalRunTimeoutMs}).\n` +
            'On timeout: this is a WAIT timeout (not a transport failure). The command KEEPS RUNNING; ' +
            'the response ends with \'[STILL RUNNING — ...]\'. Do NOT re-run the same mutating command ' +
            '(e.g. sed -i, rm, writes). Call terminal_wait to continue, or abort with terminal_send_text \'\\x03\'.\n' +
            'When calling via skills.mcp_call / mcp2cli, set timeout_seconds >= timeout_ms/1000 (plus margin) ' +
            'or the outer client may time out first with \'timed out after Ns\' while the shell command still runs.\n' +
            'For long or SSH-remote work, prefer wait=false + progressive terminal_wait.\n' +
            'Returns final output with \'[exit code: N]\' on success.\n' +
            'If terminal_name is omitted and no active terminal exists, a new terminal is auto-created (not listed by terminal_list) and the response includes the engine used (shell-integration or pty-fallback).',
        inputSchema: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'Shell command to execute' },
                terminal_name: { type: 'string', description: 'Name of a terminal created via terminal_create (optional; auto-creates if omitted)' },
                timeout_ms: {
                    type: 'number',
                    description:
                        'Hard wait in milliseconds. Optional; default is vscode-mcp.terminalRunTimeoutMs ' +
                        `(${CONFIG_DEFAULTS.terminalRunTimeoutMs}). On expiry: command keeps running; ` +
                        'response includes [STILL RUNNING]; use terminal_wait — do not treat as transport error or re-run mutators.',
                },
                wait: { type: 'boolean', description: 'Wait for output (default: true)' },
                session_id: { type: 'string', description: 'Target session ID (workspace name).' },
            },
            required: ['command'],
        },
    },
    {
        name: 'terminal_send_text',
        description:
            'Send text/input to a terminal WITHOUT capturing output. Works on busy terminals — this is ' +
            'how you answer prompts in a running command or abort it (send \'\\x03\' for Ctrl+C, ' +
            '\'\\x04\' for Ctrl+D). Use terminal_wait afterward to retrieve the result.',
        inputSchema: {
            type: 'object',
            properties: {
                text: { type: 'string', description: 'Text to send. Use \\x03 for Ctrl+C, \\x04 for Ctrl+D.' },
                terminal_name: { type: 'string', description: 'Name of target terminal (optional)' },
                add_newline: { type: 'boolean', description: 'Whether to append newline (default: true)' },
                session_id: { type: 'string', description: 'Target session ID (workspace name).' },
            },
            required: ['text'],
        },
    },
    {
        name: 'terminal_read_output',
        description:
            'Read raw buffered output from a terminal (no exit code, includes user-typed command output too). ' +
            'For commands started via terminal_run(wait=false), prefer terminal_wait to retrieve output + exit code.',
        inputSchema: {
            type: 'object',
            properties: {
                terminal_name: { type: 'string', description: 'Name of terminal to read (optional)' },
                lines: { type: 'number', description: 'Number of last lines to return (optional)' },
                session_id: { type: 'string', description: 'Target session ID (workspace name).' },
            },
        },
    },
    {
        name: 'terminal_clear_buffer',
        description: 'Clear the output buffer for a terminal (start fresh).',
        inputSchema: {
            type: 'object',
            properties: {
                terminal_name: { type: 'string', description: 'Name of terminal (optional)' },
                session_id: { type: 'string', description: 'Target session ID (workspace name).' },
            },
        },
    },
    {
        name: 'terminal_wait',
        description:
            'Wait for the current (or most recent) execution in a terminal to finish, and return its ' +
            'output and exit code. Blocks up to timeout_ms.\n' +
            'Default timeout_ms = vscode-mcp.terminalWaitTimeoutMs from extension settings ' +
            `(package.json default ${CONFIG_DEFAULTS.terminalWaitTimeoutMs}).\n` +
            'On timeout: WAIT timeout (not transport failure). Returns output accumulated during this wait ' +
            'with \'[STILL RUNNING — ...]\'. Call again to continue waiting, or send \'\\x03\' via terminal_send_text to abort. ' +
            'Do not re-run the original mutating command.',
        inputSchema: {
            type: 'object',
            properties: {
                terminal_name: { type: 'string', description: 'Name of a terminal created via terminal_create.' },
                timeout_ms: {
                    type: 'number',
                    description:
                        'Max milliseconds to block. Optional; default is vscode-mcp.terminalWaitTimeoutMs ' +
                        `(${CONFIG_DEFAULTS.terminalWaitTimeoutMs}). On expiry: [STILL RUNNING]; call again — not a transport error.`,
                },
                session_id: { type: 'string', description: 'Target session ID (workspace name).' },
            },
        },
    },
    {
        name: 'get_diagnostics',
        description:
            'Get VS Code diagnostics (errors, warnings, hints) from all open files or a specific file.',
        inputSchema: {
            type: 'object',
            properties: {
                uri: { type: 'string', description: 'File path or URI to get diagnostics for (optional)' },
                severity: { type: 'string', enum: ['error', 'warning', 'information', 'hint'], description: 'Filter by severity (optional)' },
                session_id: { type: 'string', description: 'Target session ID (workspace name).' },
            },
        },
    },
    {
        name: 'get_document_symbols',
        description:
            'Get the symbol outline of a file (functions, classes, methods, variables, exports) without reading the entire file.',
        inputSchema: {
            type: 'object',
            properties: {
                uri: { type: 'string', description: 'File path or URI to get symbols for' },
                session_id: { type: 'string', description: 'Target session ID (workspace name).' },
            },
            required: ['uri'],
        },
    },
    {
        name: 'get_references',
        description:
            'Find all references (usages) of a symbol across the entire workspace.',
        inputSchema: {
            type: 'object',
            properties: {
                uri: { type: 'string', description: 'File path or URI containing the symbol' },
                line: { type: 'number', description: 'Line number (0-based) of the symbol' },
                character: { type: 'number', description: 'Column number (0-based) of the symbol' },
                session_id: { type: 'string', description: 'Target session ID (workspace name).' },
            },
            required: ['uri', 'line', 'character'],
        },
    },
    {
        name: 'rename_symbol',
        description:
            'Rename a symbol across the entire workspace using VS Code LSP.',
        inputSchema: {
            type: 'object',
            properties: {
                uri: { type: 'string', description: 'File path or URI containing the symbol to rename' },
                line: { type: 'number', description: 'Line number (0-based) of the symbol' },
                character: { type: 'number', description: 'Column number (0-based) of the symbol' },
                new_name: { type: 'string', description: 'New name for the symbol' },
                session_id: { type: 'string', description: 'Target session ID (workspace name).' },
            },
            required: ['uri', 'line', 'character', 'new_name'],
        },
    },
    {
        name: 'run_command',
        description:
            'Execute any VS Code command by ID. Universal escape hatch — anything VS Code can do, the agent can trigger.',
        inputSchema: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'VS Code command ID' },
                args: { type: 'array', description: 'Optional arguments to pass to the command', items: {} },
                session_id: { type: 'string', description: 'Target session ID (workspace name).' },
            },
            required: ['command'],
        },
    },
    {
        name: 'execute',
        description:
            'Execute a shell command directly (NOT via VS Code terminal) and capture output.\n' +
            'Spawns a child process with stdio pipes — no terminal tab is shown. ' +
            'stdout, stderr, and exit code are captured and returned.\n' +
            'stdin is piped to the process if provided.\n' +
            'Default timeout_ms = vscode-mcp.terminalRunTimeoutMs from extension settings ' +
            `(package.json default ${CONFIG_DEFAULTS.terminalRunTimeoutMs}).\n` +
            'On timeout: the process is killed (SIGTERM, then SIGKILL after 3s) and the response ' +
            'includes partial output with \'[STILL RUNNING]\'. This is a wait timeout, not a transport failure.\n' +
            'Use this for quick, self-contained commands. For interactive commands or persistent shell ' +
            'state (cd, env persistence), use terminal_run instead.',
        inputSchema: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'Shell command to execute (run via shell)' },
                stdin: { type: 'string', description: 'String to pipe to the process stdin (optional)' },
                cwd: { type: 'string', description: 'Working directory. Defaults to the workspace folder root.' },
                timeout_ms: {
                    type: 'number',
                    description:
                        'Hard timeout in milliseconds. Optional; default is vscode-mcp.terminalRunTimeoutMs ' +
                        `(${CONFIG_DEFAULTS.terminalRunTimeoutMs}). On expiry: process is killed, partial output returned.`,
                },
                env: {
                    type: 'object',
                    description: 'Additional environment variables merged on top of the current process.env (optional)',
                    additionalProperties: true,
                },
                max_output_bytes: {
                    type: 'number',
                    description:
                        'Max combined stdout+stderr size in bytes before truncation. Optional; ' +
                        `default is vscode-mcp.maxOutputBytes (${CONFIG_DEFAULTS.maxOutputBytes}). ` +
                        'If output exceeds this, the process is killed and output is truncated.',
                },
                session_id: { type: 'string', description: 'Target session ID (workspace name).' },
            },
            required: ['command'],
        },
    },
    {
        name: 'open_file',
        description:
            'Open a file in the VS Code editor and optionally jump to a line or highlight a range. ' +
            'NOTE: This is a VISUAL action only. It opens the file for the human user to see. ' +
            'It does NOT return file contents to the agent, does NOT give edit capabilities, ' +
            'and does NOT provide programmatic access to the file. ' +
            'For reading files use terminal commands (e.g., cat, head, sed). ',
        inputSchema: {
            type: 'object',
            properties: {
                file: { type: 'string', description: 'File path to open' },
                line: { type: 'number', description: 'Line number to jump to, 1-based (optional)' },
                end_line: { type: 'number', description: 'End line to highlight a range, 1-based (optional)' },
                session_id: { type: 'string', description: 'Target session ID (workspace name).' },
            },
            required: ['file'],
        },
    },
    {
        name: 'format_document',
        description:
            'Format a file using the configured formatter (Prettier, ESLint, etc.) and save it.',
        inputSchema: {
            type: 'object',
            properties: {
                file: { type: 'string', description: 'File path to format' },
                session_id: { type: 'string', description: 'Target session ID (workspace name).' },
            },
            required: ['file'],
        },
    },
    {
        name: 'organize_imports',
        description:
            'Remove unused imports and sort remaining imports in a file, then save.',
        inputSchema: {
            type: 'object',
            properties: {
                file: { type: 'string', description: 'File path to organize imports in' },
                session_id: { type: 'string', description: 'Target session ID (workspace name).' },
            },
            required: ['file'],
        },
    },
    {
        name: 'fix_all',
        description:
            'Apply all auto-fixable diagnostics in a file (ESLint auto-fixes, missing semicolons, etc.) and save it.',
        inputSchema: {
            type: 'object',
            properties: {
                file: { type: 'string', description: 'File path to auto-fix' },
                session_id: { type: 'string', description: 'Target session ID (workspace name).' },
            },
            required: ['file'],
        },
    },
    {
        name: 'save_all',
        description: 'Save all open files with unsaved changes.',
        inputSchema: {
            type: 'object',
            properties: {
                session_id: { type: 'string', description: 'Target session ID (workspace name).' },
            },
        },
    },
    {
        name: 'find_in_files',
        description:
            'Open the VS Code workspace search panel with a query.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Search query string' },
                replace: { type: 'string', description: 'Replacement string (optional)' },
                is_regex: { type: 'boolean', description: 'Treat query as a regex (default: false)' },
                include: { type: 'string', description: 'Glob pattern for files to include' },
                exclude: { type: 'string', description: 'Glob pattern for files to exclude' },
                session_id: { type: 'string', description: 'Target session ID (workspace name).' },
            },
            required: ['query'],
        },
    },
    {
        name: 'get_hover_info',
        description:
            'Get type information, documentation, and signatures for a symbol at a specific position.',
        inputSchema: {
            type: 'object',
            properties: {
                uri: { type: 'string', description: 'File path or URI' },
                line: { type: 'number', description: 'Line number (0-based)' },
                character: { type: 'number', description: 'Column number (0-based)' },
                session_id: { type: 'string', description: 'Target session ID (workspace name).' },
            },
            required: ['uri', 'line', 'character'],
        },
    },
    {
        name: 'debug_breakpoints',
        description:
            'Add, remove, list, or clear breakpoints. Works without an active debug session.',
        inputSchema: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['add', 'remove', 'list', 'clear'], description: 'Breakpoint operation to perform' },
                file: { type: 'string', description: 'File path (required for add/remove)' },
                line: { type: 'number', description: 'Line number, 1-based (required for add/remove)' },
                condition: { type: 'string', description: 'Conditional expression (optional)' },
                hit_condition: { type: 'string', description: 'Hit count expression (optional)' },
                log_message: { type: 'string', description: 'Log message — makes it a logpoint (optional)' },
                session_id: { type: 'string', description: 'Target session ID (workspace name).' },
            },
            required: ['action'],
        },
    },
    {
        name: 'debug_start',
        description:
            'Start a debug session. Provide either a launch.json config name or an inline config object.',
        inputSchema: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Name of a launch.json configuration to run' },
                config: { type: 'object', description: 'Inline debug configuration object' },
                session_id: { type: 'string', description: 'Target session ID (workspace name).' },
            },
        },
    },
    {
        name: 'debug_stop',
        description:
            'Stop a debug session. By default stops the active session; set all=true to stop every session.',
        inputSchema: {
            type: 'object',
            properties: {
                all: { type: 'boolean', description: 'Stop all debug sessions (default: false)' },
                clear_breakpoints: { type: 'boolean', description: 'Clear all breakpoints after stopping (default: false)' },
                session_id: { type: 'string', description: 'Target session ID (workspace name).' },
            },
        },
    },
    {
        name: 'debug_state',
        description:
            'Get a full snapshot of the current debug state: threads, call stacks, scopes, and variables — all in one call.',
        inputSchema: {
            type: 'object',
            properties: {
                thread_id: { type: 'number', description: 'Specific thread ID (optional)' },
                max_depth: { type: 'number', description: 'Max variable nesting depth to expand (default: 1)' },
                session_id: { type: 'string', description: 'Target session ID (workspace name).' },
            },
        },
    },
    {
        name: 'debug_control',
        description:
            'Control execution of a debug session: continue, pause, step over/into/out, restart, or evaluate expressions.',
        inputSchema: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['continue', 'pause', 'next', 'stepIn', 'stepOut', 'restart', 'evaluate'], description: 'Debug action to perform' },
                thread_id: { type: 'number', description: 'Thread ID (optional)' },
                expression: { type: 'string', description: 'Expression to evaluate (required for "evaluate")' },
                frame_id: { type: 'number', description: 'Frame ID for evaluation context (optional)' },
                context: { type: 'string', enum: ['watch', 'repl', 'hover'], description: 'Evaluation context (default: repl)' },
                session_id: { type: 'string', description: 'Target session ID (workspace name).' },
            },
            required: ['action'],
        },
    },
    {
        name: 'debug_console_output',
        description:
            'Read debug console output (console.log, stderr, debugger messages) from the current or most recent debug session.',
        inputSchema: {
            type: 'object',
            properties: {
                lines: { type: 'number', description: 'Number of last lines to return (optional)' },
                clear: { type: 'boolean', description: 'Clear the buffer after reading (default: false)' },
                session_id: { type: 'string', description: 'Target session ID (workspace name).' },
            },
        },
    },
];

export class ServerlessServer {
    private terminalManager: TerminalManager;
    private ptyManager: PtyTerminalManager;
    private sessionId: string;
    private terminalEngine: 'auto' | 'force-fallback';
    private debugOutputBuffer: string[] = [];
    private maxDebugOutputLines: number;
    private ws: WebSocket | null = null;
    private wsUrl: string | null = null;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private hubLostCallback: (() => void) | null = null;
    private intentionallyStopped = false;
    private isReconnecting = false;
    readonly port = 0;

    constructor(
        terminalManager: TerminalManager,
        ptyManager: PtyTerminalManager,
        sessionId: string,
        terminalEngine: 'auto' | 'force-fallback' = 'auto',
        maxDebugOutputLines = 2000
    ) {
        this.terminalManager = terminalManager;
        this.ptyManager = ptyManager;
        this.sessionId = sessionId;
        this.terminalEngine = terminalEngine;
        this.maxDebugOutputLines = maxDebugOutputLines;
    }

    get isRunning(): boolean {
        return true;
    }

    /** Register a callback invoked when the hub connection is lost. */
    onHubLost(callback: () => void): void {
        this.hubLostCallback = callback;
    }

    /** Connect to the hub as a satellite via WebSocket. */
    async connectAsSatellite(wsUrl: string): Promise<void> {
        // Prevent multiple concurrent reconnection attempts — reject so caller
        // does not treat a no-op as a successful connect.
        if (this.isReconnecting) {
            log(`[satellite] reconnect already in progress, skipping`);
            throw new Error('Satellite reconnect already in progress');
        }
        this.isReconnecting = true;
        this.intentionallyStopped = false;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        try {
            log(`[satellite] connectAsSatellite(${wsUrl}) — session="${this.sessionId}"`);
            this.wsUrl = wsUrl;
            // Replace existing socket without firing hubLost / reconnect.
            replaceSocket(this.ws);
            this.ws = null;
            let hubLostAlreadyCalled = false;
            await new Promise<void>((resolve, reject) => {
                const ws = new WebSocket(wsUrl);
                const onOpen = () => {
                    this.ws = ws;
                    this.isReconnecting = false;
                    log(`[satellite] WebSocket open, sending register for session="${this.sessionId}"`);
                    sendMessage(ws, { type: 'register', sessionId: this.sessionId });
                    resolve();
                };
                const onClose = () => {
                    log(`[satellite] WebSocket closed`);
                    this.ws = null;
                    // Outer retryConnection owns reconnect; only notify once.
                    if (!this.intentionallyStopped && !hubLostAlreadyCalled) {
                        hubLostAlreadyCalled = true;
                        this.hubLostCallback?.();
                    }
                };
                ws.on('open', onOpen);
                ws.on('message', (data) => this.handleMessage(data));
                ws.on('close', onClose);
                ws.on('error', (err) => {
                    log(`[satellite] WebSocket error: ${err}`);
                    if (!this.ws) {
                        cleanup();
                        reject(err);
                    }
                });
                function cleanup() {
                    ws.off('open', onOpen);
                    ws.off('close', onClose);
                }
            });
        } catch (e) {
            this.isReconnecting = false;
            throw e;
        }
    }

    private handleMessage(data: WebSocket.RawData): void {
        const msg = parseWsMessage(data);
        if (!msg) return;
        switch (msg.type) {
            case 'execute':
                log(`[satellite] execute received — tool="${msg.tool}" requestId=${msg.requestId}`);
                this.callTool(msg.tool, msg.params || {})
                    .then((result) => {
                        log(`[agent] callTool resolved — tool="${msg.tool}" requestId=${msg.requestId}, sending result`);
                        sendMessage(this.ws, { type: 'result', requestId: msg.requestId, result });
                    })
                    .catch((err) => {
                        log(`[agent] callTool rejected — tool="${msg.tool}" requestId=${msg.requestId}: ${err}`);
                        sendMessage(this.ws, { type: 'error', requestId: msg.requestId, message: String(err) });
                    });
                break;
            case 'ping':
                sendMessage(this.ws, { type: 'pong' });
                break;
        }
    }

    stop(): void {
        this.intentionallyStopped = true;
        this.isReconnecting = false;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        replaceSocket(this.ws);
        this.ws = null;
        this.wsUrl = null;
    }

    private usePtyFallback(): boolean {
        return this.terminalEngine === 'force-fallback';
    }

    appendDebugOutput(output: string, category?: string): void {
        const prefix = category && category !== 'stdout' ? `[${category}] ` : '';
        const lines = output.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].replace(/\r$/, '');
            if (i === lines.length - 1 && line === '') continue;
            this.debugOutputBuffer.push(prefix + line);
        }
        if (this.debugOutputBuffer.length > this.maxDebugOutputLines) {
            this.debugOutputBuffer.splice(0, this.debugOutputBuffer.length - this.maxDebugOutputLines);
        }
    }

    readDebugOutput(lines?: number): string {
        if (this.debugOutputBuffer.length === 0) return '(no debug output)';
        const slice = lines ? this.debugOutputBuffer.slice(-lines) : this.debugOutputBuffer;
        return slice.join('\n');
    }

    clearDebugOutput(): void {
        this.debugOutputBuffer = [];
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
            return { content: [{ type: 'text', text: message }], isError: true };
        }
    }

    /**
     * Resolve a terminal_name to its engine. The name must be registered
     * (created via terminal_create); otherwise an error lists the registered names.
     * Returns undefined when no terminal_name is given (caller auto-creates).
     */
    private resolveTerminalEngine(name: string | undefined): 'pty' | 'shell' | undefined {
        if (!name) return undefined;
        if (this.ptyManager.hasTerminal(name)) return 'pty';
        if (this.terminalManager.hasTerminal(name)) return 'shell';
        const terminals = this.listManagedTerminals();
        const open = terminals.map((t) => `"${t.name}"`).join(', ') || 'none';
        throw new Error(
            `Terminal "${name}" is not registered. Create it with terminal_create first. Registered: ${open}`
        );
    }

    /** Compute a unique terminal name from a prefix across both engines (prefix, prefix_1, prefix_2, ...). */
    private nextUniqueName(prefix: string): string {
        if (!this.ptyManager.hasTerminal(prefix) && !this.terminalManager.hasTerminal(prefix)) {
            return prefix;
        }
        let i = 1;
        while (this.ptyManager.hasTerminal(`${prefix}_${i}`) || this.terminalManager.hasTerminal(`${prefix}_${i}`)) {
            i++;
        }
        return `${prefix}_${i}`;
    }

    /** List managed terminals across both engines (shell-integration + pty-fallback). */
    private listManagedTerminals(): Array<{ id: string; name: string; isActive: boolean; hasShellIntegration: boolean; engine: 'shell-integration' | 'pty-fallback' }> {
        const ptyTerms = this.ptyManager.listTerminals();
        const shellTerms = this.terminalManager.listTerminals().filter(
            (s) => !ptyTerms.some((p) => p.id === s.id)
        );
        return [...ptyTerms, ...shellTerms];
    }

    private async invokeTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
        const text = (s: string, isError = false): ToolResult => ({
            content: [{ type: 'text', text: s }],
            ...(isError ? { isError: true } : {}),
        });

        switch (name) {
            case 'get_version': {
                const ext = vscode.extensions.getExtension('prog76.vscode-mcp-extension');
                if (!ext) {
                    return text('vscode-mcp extension not found.');
                }
                const pkgPath = path.join(ext.extensionPath, 'package.json');
                let version = 'unknown';
                try {
                    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
                    version = pkg.version || 'unknown';
                } catch {
                    // fallback to unknown
                }
                return text(`vscode-mcp version: ${version}`);
            }

            case 'terminal_list_sessions': {
                log(`[agent] terminal_list_sessions: session="${this.sessionId}"`);
                return text(`[hub] session="${this.sessionId}"`);
            }

            case 'terminal_list': {
                log(`[agent] terminal_list: session="${this.sessionId}"`);
                const terminals = this.listManagedTerminals();
                if (terminals.length === 0) return text('No terminals created via terminal_create.');
                const lines = terminals.map(
                    (t) =>
                        `[${t.id}] "${t.name}"${t.isActive ? ' (active)' : ''}${t.hasShellIntegration ? ' [shell-integration]' : ' [no shell-integration]'}`
                );
                return text(lines.join('\n'));
            }

            case 'terminal_run': {
                log(`[agent] terminal_run: command="${args.command}" session="${this.sessionId}"`);
                const command = args.command as string;
                const terminalName = args.terminal_name as string | undefined;
                const engine = this.resolveTerminalEngine(terminalName);
                const wait = (args.wait as boolean | undefined) ?? true;
                const timeoutMs =
                    (args.timeout_ms as number | undefined) ?? getTerminalRunTimeoutMs();
                const stdin = args.stdin as string | undefined;
                if (engine === 'pty') {
                    if (!wait) {
                        const result = await this.ptyManager.startBackgroundExecution(command, terminalName);
                        return text(result.message);
                    }
                    const result = await this.ptyManager.executeCommand(command, terminalName, timeoutMs);
                    return text(this.formatCommandResult(result));
                }
                if (stdin) {
                    this.terminalManager.sendText(command, terminalName, true);
                    await new Promise((r) => setTimeout(r, 100));
                    this.terminalManager.sendText(stdin, terminalName, true);
                    return text(`Command sent with stdin. Use terminal_wait to retrieve output.`);
                }
                if (!wait) {
                    const result = await this.terminalManager.startBackgroundExecution(command, terminalName);
                    return text(result.message);
                }
                const result = await this.terminalManager.executeCommand(command, terminalName, timeoutMs);
                return text(this.formatCommandResult(result));
            }

            case 'terminal_create': {
                log(`[agent] terminal_create: name_prefix="${args.name_prefix}" session="${this.sessionId}"`);
                const prefix = args.name_prefix as string;
                const cwd = args.cwd as string | undefined;
                const engine = args.engine as 'auto' | 'shell' | 'pty' | undefined;
                const shell = args.shell as string | undefined;
                const usePty = engine === 'pty' || (engine === 'auto' && this.usePtyFallback());
                const name = this.nextUniqueName(prefix);
                let result: { terminalName: string; engine: 'shell-integration' | 'pty-fallback' };
                if (usePty) {
                    result = this.ptyManager.createTerminal(name, cwd, shell);
                } else {
                    result = await this.terminalManager.createTerminal(name, cwd, shell);
                }
                return text(`Created terminal "${result.terminalName}" (engine: ${result.engine})`);
            }

            case 'terminal_send_text': {
                const rawText = args.text as string;
                const processed = rawText
                    .replace(/\\x03/g, '\x03')
                    .replace(/\\x04/g, '\x04')
                    .replace(/\\n/g, '\n');
                const terminalName = args.terminal_name as string | undefined;
                const engine = this.resolveTerminalEngine(terminalName);
                const addNewline = (args.add_newline as boolean | undefined) ?? true;
                if (engine === 'pty') {
                    this.ptyManager.sendText(processed, terminalName, addNewline);
                } else {
                    this.terminalManager.sendText(processed, terminalName, addNewline);
                }
                return text(`Text sent to terminal${terminalName ? ` "${terminalName}"` : ''}.`);
            }

            case 'terminal_read_output': {
                const terminalName = args.terminal_name as string | undefined;
                const engine = this.resolveTerminalEngine(terminalName);
                const lines = args.lines as number | undefined;
                if (engine === 'pty') {
                    return text(this.ptyManager.readOutput(terminalName, lines));
                }
                return text(this.terminalManager.readOutput(terminalName, lines));
            }

            case 'terminal_clear_buffer': {
                const terminalName = args.terminal_name as string | undefined;
                const engine = this.resolveTerminalEngine(terminalName);
                if (engine === 'pty') {
                    this.ptyManager.clearBuffer(terminalName);
                } else {
                    this.terminalManager.clearBuffer(terminalName);
                }
                return text('Buffer cleared.');
            }

            case 'terminal_wait': {
                const terminalName = args.terminal_name as string | undefined;
                const engine = this.resolveTerminalEngine(terminalName);
                if (!terminalName) {
                    throw new Error("terminal_wait requires 'terminal_name'.");
                }
                const timeoutMs =
                    (args.timeout_ms as number | undefined) ?? getTerminalWaitTimeoutMs();
                if (engine === 'pty') {
                    const result = await this.ptyManager.waitForExecution(terminalName, timeoutMs);
                    return text(this.formatCommandResult(result));
                }
                const result = await this.terminalManager.waitForExecution(terminalName, timeoutMs);
                return text(this.formatCommandResult(result));
            }

            case 'get_diagnostics': {
                const uri = args.uri as string | undefined;
                const severity = args.severity as string | undefined;

                const severityMap: Record<string, vscode.DiagnosticSeverity> = {
                    error: vscode.DiagnosticSeverity.Error,
                    warning: vscode.DiagnosticSeverity.Warning,
                    information: vscode.DiagnosticSeverity.Information,
                    hint: vscode.DiagnosticSeverity.Hint,
                };
                const severityNames: Record<number, string> = {
                    [vscode.DiagnosticSeverity.Error]: 'Error',
                    [vscode.DiagnosticSeverity.Warning]: 'Warning',
                    [vscode.DiagnosticSeverity.Information]: 'Information',
                    [vscode.DiagnosticSeverity.Hint]: 'Hint',
                };
                const filterSeverity = severity ? severityMap[severity] : undefined;

                let allDiagnostics: [vscode.Uri, vscode.Diagnostic[]][];
                if (uri) {
                    const fileUri = uri.includes('://') ? vscode.Uri.parse(uri) : vscode.Uri.file(uri);
                    const diags = vscode.languages.getDiagnostics(fileUri);
                    allDiagnostics = diags.length > 0 ? [[fileUri, diags]] : [];
                } else {
                    allDiagnostics = vscode.languages.getDiagnostics();
                }

                const lines: string[] = [];
                let totalCount = 0;

                for (const [fileUri, diagnostics] of allDiagnostics) {
                    const filtered = filterSeverity !== undefined
                        ? diagnostics.filter((d) => d.severity === filterSeverity)
                        : diagnostics;
                    if (filtered.length === 0) continue;

                    const relPath = vscode.workspace.asRelativePath(fileUri);
                    for (const d of filtered) {
                        const sev = severityNames[d.severity] || 'Unknown';
                        const line = d.range.start.line + 1;
                        const col = d.range.start.character + 1;
                        const source = d.source ? ` [${d.source}]` : '';
                        lines.push(`${relPath}:${line}:${col} ${sev}${source}: ${d.message}`);
                        totalCount++;
                    }
                }

                if (totalCount === 0) {
                    return text(uri ? `No diagnostics for ${uri}.` : 'No diagnostics found.');
                }
                return text(`${totalCount} diagnostic(s):\n\n${lines.join('\n')}`);
            }

            case 'get_document_symbols': {
                const uri = args.uri as string;
                const fileUri = uri.includes('://') ? vscode.Uri.parse(uri) : vscode.Uri.file(uri);
                const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                    'vscode.executeDocumentSymbolProvider',
                    fileUri
                );
                if (!symbols || symbols.length === 0) {
                    return text(`No symbols found in ${uri}. The file may not have a language server active.`);
                }

                const symbolKindName = (kind: vscode.SymbolKind): string => vscode.SymbolKind[kind] || 'Unknown';

                const lines: string[] = [];
                const walk = (syms: vscode.DocumentSymbol[], indent: number) => {
                    for (const s of syms) {
                        const prefix = '  '.repeat(indent);
                        const range = `${s.range.start.line + 1}–${s.range.end.line + 1}`;
                        lines.push(`${prefix}${symbolKindName(s.kind)} ${s.name} [${range}]`);
                        if (s.children && s.children.length > 0) {
                            walk(s.children, indent + 1);
                        }
                    }
                };
                walk(symbols, 0);
                return text(`${lines.length} symbol(s) in ${vscode.workspace.asRelativePath(fileUri)}:\n\n${lines.join('\n')}`);
            }

            case 'get_references': {
                const uri = args.uri as string;
                const line = args.line as number;
                const character = args.character as number;
                if (!Number.isInteger(line) || !Number.isInteger(character) || line < 0 || character < 0) {
                    return text('Error: line and character must be non-negative integers.');
                }
                const fileUri = uri.includes('://') ? vscode.Uri.parse(uri) : vscode.Uri.file(uri);
                const position = new vscode.Position(line, character);
                const locations = await vscode.commands.executeCommand<vscode.Location[]>(
                    'vscode.executeReferenceProvider',
                    fileUri,
                    position
                );
                if (!locations || locations.length === 0) {
                    return text(`No references found at ${uri}:${line}:${character}.`);
                }
                const MAX_REFS = 500;
                const lines: string[] = locations.map((loc) => {
                    const relPath = vscode.workspace.asRelativePath(loc.uri);
                    const l = loc.range.start.line + 1;
                    const c = loc.range.start.character + 1;
                    return `${relPath}:${l}:${c}`;
                });
                const output = lines.slice(0, MAX_REFS).join('\n');
                const suffix = lines.length > MAX_REFS ? `\n... and ${lines.length - MAX_REFS} more.` : '';
                return text(`${locations.length} reference(s):\n\n${output}${suffix}`);
            }

            case 'rename_symbol': {
                const uri = args.uri as string;
                const line = args.line as number;
                const character = args.character as number;
                if (!Number.isInteger(line) || !Number.isInteger(character) || line < 0 || character < 0) {
                    return text('Error: line and character must be non-negative integers.');
                }
                const newName = args.new_name as string;
                const fileUri = uri.includes('://') ? vscode.Uri.parse(uri) : vscode.Uri.file(uri);
                const position = new vscode.Position(line, character);

                let prepareResult: unknown;
                try {
                    prepareResult = await vscode.commands.executeCommand(
                        'vscode.prepareRename',
                        fileUri,
                        position
                    );
                } catch (prepErr) {
                    return text(`Cannot rename at ${uri}:${line}:${character} — ${prepErr}`);
                }
                if (!prepareResult) {
                    return text(`Cannot rename symbol at ${uri}:${line}:${character}. The element at this position is not renameable.`);
                }

                const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
                    'vscode.executeDocumentRenameProvider',
                    fileUri,
                    position,
                    newName
                );
                if (!edit) {
                    return text(`Cannot rename symbol at ${uri}:${line}:${character}. No rename provider available.`);
                }
                const entries = edit.entries();
                if (entries.length === 0) {
                    return text('Rename produced no changes.');
                }
                const applied = await vscode.workspace.applyEdit(edit);
                if (!applied) {
                    return text('Failed to apply rename edit.');
                }
                const totalEdits = entries.reduce((sum, [, edits]) => sum + edits.length, 0);
                const fileList = entries.map(([u]) => vscode.workspace.asRelativePath(u));
                for (const [affectedUri] of entries) {
                    const doc = await vscode.workspace.openTextDocument(affectedUri);
                    if (doc.isDirty) { await doc.save(); }
                }
                return text(`Renamed to "${newName}" — ${totalEdits} edit(s) across ${entries.length} file(s):\n${fileList.join('\n')}`);
            }

            case 'run_command': {
                const command = args.command as string;
                const commandArgs = args.args as unknown[] | undefined;
                try {
                    const result = commandArgs
                        ? await vscode.commands.executeCommand(command, ...commandArgs)
                        : await vscode.commands.executeCommand(command);
                    if (result === undefined || result === null) {
                        return text(`Command "${command}" executed.`);
                    }
                    if (typeof result === 'string') {
                        return text(result);
                    }
                    return text(JSON.stringify(result, null, 2));
                } catch (e) {
                    return text(`Command "${command}" failed: ${e}`);
                }
            }

            case 'execute': {
                log(`[agent] execute: command="${args.command}" session="${this.sessionId}"`);
                const command = args.command as string;
                if (!command) {
                    throw new Error("Parameter 'command' is required for execute.");
                }
                const stdin = args.stdin as string | undefined;
                const cwd = args.cwd as string | undefined;
                const timeoutMs =
                    (args.timeout_ms as number | undefined) ?? getTerminalRunTimeoutMs();
                const env = args.env as Record<string, string> | undefined;
                const maxOutputBytes =
                    (args.max_output_bytes as number | undefined) ?? getMaxOutputBytes();
                const result = await this.directExecute(command, stdin, timeoutMs, cwd, env, maxOutputBytes);
                return text(this.formatDirectResult(result));
            }

            case 'open_file': {
                const file = args.file as string;
                const line = args.line as number | undefined;
                const endLine = args.end_line as number | undefined;
                const fileUri = file.includes('://') ? vscode.Uri.parse(file) : vscode.Uri.file(file);

                const doc = await vscode.workspace.openTextDocument(fileUri);
                const editor = await vscode.window.showTextDocument(doc);

                if (line !== undefined) {
                    const startLine = Math.min(Math.max(line - 1, 0), doc.lineCount - 1);
                    const startPos = new vscode.Position(startLine, 0);
                    const endPos = endLine
                        ? new vscode.Position(
                            Math.min(endLine - 1, doc.lineCount - 1),
                            doc.lineAt(Math.min(endLine - 1, doc.lineCount - 1)).text.length
                        )
                        : startPos;
                    editor.revealRange(new vscode.Range(startPos, endPos), vscode.TextEditorRevealType.InCenter);
                    editor.selection = new vscode.Selection(startPos, endPos);
                }

                const rel = vscode.workspace.asRelativePath(fileUri);
                return text(`Opened ${rel}${line ? ` at line ${line}` : ''}${endLine ? `–${endLine}` : ''}`);
            }

            case 'format_document': {
                const file = args.file as string;
                const fileUri = file.includes('://') ? vscode.Uri.parse(file) : vscode.Uri.file(file);

                const config = vscode.workspace.getConfiguration('editor', fileUri);
                const options: vscode.FormattingOptions = {
                    tabSize: config.get<number>('tabSize', 4),
                    insertSpaces: config.get<boolean>('insertSpaces', true),
                };

                const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
                    'vscode.executeFormatDocumentProvider',
                    fileUri,
                    options
                );

                if (!edits || edits.length === 0) {
                    return text(`No formatting changes needed for ${vscode.workspace.asRelativePath(fileUri)}.`);
                }

                const wsEdit = new vscode.WorkspaceEdit();
                for (const edit of edits) {
                    wsEdit.replace(fileUri, edit.range, edit.newText);
                }
                await vscode.workspace.applyEdit(wsEdit);

                const doc = await vscode.workspace.openTextDocument(fileUri);
                if (doc.isDirty) await doc.save();

                return text(`Formatted ${vscode.workspace.asRelativePath(fileUri)} (${edits.length} edit(s) applied).`);
            }

            case 'organize_imports': {
                const file = args.file as string;
                const fileUri = file.includes('://') ? vscode.Uri.parse(file) : vscode.Uri.file(file);
                const doc = await vscode.workspace.openTextDocument(fileUri);
                const fullRange = doc.validateRange(new vscode.Range(0, 0, doc.lineCount, 0));

                const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
                    'vscode.executeCodeActionProvider',
                    fileUri,
                    fullRange,
                    vscode.CodeActionKind.SourceOrganizeImports.value
                );

                if (!actions || actions.length === 0) {
                    return text(`No import changes needed for ${vscode.workspace.asRelativePath(fileUri)}.`);
                }

                for (const action of actions) {
                    if (action.edit) {
                        await vscode.workspace.applyEdit(action.edit);
                    }
                }

                if (doc.isDirty) await doc.save();
                return text(`Organized imports in ${vscode.workspace.asRelativePath(fileUri)}.`);
            }

            case 'fix_all': {
                const file = args.file as string;
                const fileUri = file.includes('://') ? vscode.Uri.parse(file) : vscode.Uri.file(file);
                const doc = await vscode.workspace.openTextDocument(fileUri);
                const fullRange = doc.validateRange(new vscode.Range(0, 0, doc.lineCount, 0));

                const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
                    'vscode.executeCodeActionProvider',
                    fileUri,
                    fullRange,
                    vscode.CodeActionKind.SourceFixAll.value
                );

                if (!actions || actions.length === 0) {
                    return text(`No auto-fixable issues in ${vscode.workspace.asRelativePath(fileUri)}.`);
                }

                let fixCount = 0;
                for (const action of actions) {
                    if (action.edit) {
                        await vscode.workspace.applyEdit(action.edit);
                        fixCount++;
                    }
                }

                if (fixCount === 0) {
                    return text(`No auto-fixable issues in ${vscode.workspace.asRelativePath(fileUri)}.`);
                }
                if (doc.isDirty) await doc.save();
                return text(`Applied ${fixCount} fix(es) in ${vscode.workspace.asRelativePath(fileUri)}.`);
            }

            case 'save_all': {
                await vscode.workspace.saveAll(false);
                return text('All files saved.');
            }

            case 'find_in_files': {
                const query = args.query as string;
                const replace = args.replace as string | undefined;
                const isRegex = args.is_regex as boolean | undefined;
                const include = args.include as string | undefined;
                const exclude = args.exclude as string | undefined;

                await vscode.commands.executeCommand('workbench.action.findInFiles', {
                    query,
                    replace,
                    isRegex: isRegex ?? false,
                    filesToInclude: include ?? '',
                    filesToExclude: exclude ?? '',
                    triggerSearch: true,
                });

                return text(`Search opened for "${query}"${replace ? ` with replace "${replace}"` : ''}.`);
            }

            case 'get_hover_info': {
                const uri = args.uri as string;
                const line = args.line as number;
                const character = args.character as number;
                const fileUri = uri.includes('://') ? vscode.Uri.parse(uri) : vscode.Uri.file(uri);
                const position = new vscode.Position(line, character);

                const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
                    'vscode.executeHoverProvider',
                    fileUri,
                    position
                );

                if (!hovers || hovers.length === 0) {
                    return text(`No hover info at ${vscode.workspace.asRelativePath(fileUri)}:${line}:${character}.`);
                }

                const parts: string[] = [];
                for (const hover of hovers) {
                    for (const content of hover.contents) {
                        if (typeof content === 'string') {
                            parts.push(content);
                        } else if ('value' in content) {
                            parts.push(content.value);
                        }
                    }
                }

                return text(parts.join('\n\n'));
            }

            case 'debug_breakpoints': {
                const action = args.action as string;

                if (action === 'list') {
                    const bps = vscode.debug.breakpoints;
                    if (bps.length === 0) return text('No breakpoints set.');
                    const lines: string[] = [];
                    for (const bp of bps) {
                        if (bp instanceof vscode.SourceBreakpoint) {
                            const loc = bp.location;
                            const rel = vscode.workspace.asRelativePath(loc.uri);
                            const line = loc.range.start.line + 1;
                            let desc = `${rel}:${line}`;
                            if (bp.condition) desc += ` condition="${bp.condition}"`;
                            if (bp.hitCondition) desc += ` hitCondition="${bp.hitCondition}"`;
                            if (bp.logMessage) desc += ` log="${bp.logMessage}"`;
                            if (!bp.enabled) desc += ' (disabled)';
                            lines.push(desc);
                        } else if (bp instanceof vscode.FunctionBreakpoint) {
                            let desc = `function: ${bp.functionName}`;
                            if (bp.condition) desc += ` condition="${bp.condition}"`;
                            if (!bp.enabled) desc += ' (disabled)';
                            lines.push(desc);
                        }
                    }
                    return text(`${lines.length} breakpoint(s):\n${lines.join('\n')}`);
                }

                if (action === 'clear') {
                    const bps = vscode.debug.breakpoints;
                    if (bps.length === 0) return text('No breakpoints to clear.');
                    vscode.debug.removeBreakpoints(bps);
                    return text(`Cleared ${bps.length} breakpoint(s).`);
                }

                const file = args.file as string | undefined;
                const line = args.line as number | undefined;
                if (!file || line === undefined) {
                    return text('Error: "file" and "line" are required for add/remove.');
                }
                const fileUri = file.includes('://') ? vscode.Uri.parse(file) : vscode.Uri.file(file);
                const position = new vscode.Position(line - 1, 0);
                const location = new vscode.Location(fileUri, position);

                if (action === 'add') {
                    const bp = new vscode.SourceBreakpoint(
                        location,
                        true,
                        args.condition as string | undefined,
                        args.hit_condition as string | undefined,
                        args.log_message as string | undefined,
                    );
                    vscode.debug.addBreakpoints([bp]);
                    const rel = vscode.workspace.asRelativePath(fileUri);
                    return text(`Breakpoint added: ${rel}:${line}`);
                }

                if (action === 'remove') {
                    const match = vscode.debug.breakpoints.find(
                        (bp) =>
                            bp instanceof vscode.SourceBreakpoint &&
                            bp.location.uri.fsPath === fileUri.fsPath &&
                            bp.location.range.start.line === line - 1
                    );
                    if (!match) {
                        return text(`No breakpoint found at ${vscode.workspace.asRelativePath(fileUri)}:${line}.`);
                    }
                    vscode.debug.removeBreakpoints([match]);
                    return text(`Breakpoint removed: ${vscode.workspace.asRelativePath(fileUri)}:${line}`);
                }

                return text(`Unknown breakpoint action: "${action}". Use add, remove, list, or clear.`);
            }

            case 'debug_start': {
                const configName = args.name as string | undefined;
                const inlineConfig = args.config as vscode.DebugConfiguration | undefined;
                const folder = vscode.workspace.workspaceFolders?.[0];

                let started: boolean;
                if (inlineConfig) {
                    started = await vscode.debug.startDebugging(folder, inlineConfig);
                } else if (configName) {
                    started = await vscode.debug.startDebugging(folder, configName);
                } else {
                    started = await vscode.debug.startDebugging(folder, undefined as unknown as string);
                }

                if (!started) {
                    return text('Failed to start debug session. Check that a valid launch configuration exists.');
                }
                await new Promise((r) => setTimeout(r, 500));
                const session = vscode.debug.activeDebugSession;
                return text(
                    `Debug session started: "${session?.name ?? 'unknown'}" (type: ${session?.type ?? 'unknown'})`
                );
            }

            case 'debug_stop': {
                const all = args.all as boolean | undefined;
                const clearBps = args.clear_breakpoints as boolean | undefined;
                if (all) {
                    await vscode.debug.stopDebugging(undefined);
                } else {
                    const session = vscode.debug.activeDebugSession;
                    if (!session) {
                        return text('No active debug session.');
                    }
                    await vscode.debug.stopDebugging(session);
                }
                let msg = all ? 'All debug sessions stopped.' : 'Debug session stopped.';
                if (clearBps) {
                    const bps = vscode.debug.breakpoints;
                    if (bps.length > 0) {
                        vscode.debug.removeBreakpoints(bps);
                        msg += ` Cleared ${bps.length} breakpoint(s).`;
                    }
                }
                return text(msg);
            }

            case 'debug_state': {
                const session = vscode.debug.activeDebugSession;
                if (!session) {
                    return text('No active debug session.');
                }
                const targetThreadId = args.thread_id as number | undefined;
                const maxDepth = (args.max_depth as number | undefined) ?? 1;

                const threadsResp = await session.customRequest('threads');
                const threads: Array<{ id: number; name: string }> = threadsResp.threads ?? [];
                if (threads.length === 0) {
                    return text('No threads available.');
                }

                const filtered = targetThreadId
                    ? threads.filter((t) => t.id === targetThreadId)
                    : threads;
                if (filtered.length === 0) {
                    return text(`Thread ${targetThreadId} not found. Available: ${threads.map((t) => t.id).join(', ')}`);
                }

                const output: string[] = [];
                for (const thread of filtered) {
                    let stackFrames: Array<{
                        id: number;
                        name: string;
                        source?: { name?: string; path?: string };
                        line: number;
                        column: number;
                    }> = [];
                    let stoppedReason = '';
                    try {
                        const stResp = await session.customRequest('stackTrace', {
                            threadId: thread.id,
                            startFrame: 0,
                            levels: 20,
                        });
                        stackFrames = stResp.stackFrames ?? [];
                    } catch {
                        stoppedReason = 'running';
                    }

                    output.push(
                        `Thread #${thread.id} "${thread.name}"${stoppedReason ? ` (${stoppedReason})` : ''}`
                    );

                    for (const frame of stackFrames) {
                        const src = frame.source?.path
                            ? vscode.workspace.asRelativePath(frame.source.path)
                            : frame.source?.name ?? '<unknown>';
                        output.push(`  Frame #${frame.id}: ${src}:${frame.line} in ${frame.name}`);

                        if (maxDepth < 1) continue;

                        try {
                            const scopesResp = await session.customRequest('scopes', { frameId: frame.id });
                            const scopes: Array<{ name: string; variablesReference: number; expensive: boolean }> =
                                scopesResp.scopes ?? [];

                            for (const scope of scopes) {
                                if (scope.expensive) {
                                    output.push(`    ${scope.name}: (expensive — skipped)`);
                                    continue;
                                }
                                output.push(`    ${scope.name}:`);
                                await this.expandVariables(session, scope.variablesReference, 1, maxDepth, 3, output);
                            }
                        } catch {
                            // scopes unavailable for this frame
                        }
                    }
                }

                return text(output.join('\n'));
            }

            case 'debug_control': {
                const session = vscode.debug.activeDebugSession;
                if (!session) {
                    return text('No active debug session.');
                }
                const action = args.action as string;

                if (action === 'evaluate') {
                    const expression = args.expression as string | undefined;
                    if (!expression) {
                        return text('Error: "expression" is required for evaluate.');
                    }
                    const evalArgs: Record<string, unknown> = {
                        expression,
                        context: (args.context as string) ?? 'repl',
                    };
                    if (args.frame_id !== undefined) {
                        evalArgs.frameId = args.frame_id;
                    }
                    const result = await session.customRequest('evaluate', evalArgs);
                    return text(result.result ?? '(no result)');
                }

                if (action === 'restart') {
                    await vscode.commands.executeCommand('workbench.action.debug.restart');
                    return text('Debug session restarting.');
                }

                let threadId = args.thread_id as number | undefined;
                if (threadId === undefined) {
                    const threadsResp = await session.customRequest('threads');
                    const threads: Array<{ id: number }> = threadsResp.threads ?? [];
                    if (threads.length === 0) {
                        return text('No threads available.');
                    }
                    threadId = threads[0].id;
                }

                try {
                    await session.customRequest(action, { threadId });
                } catch (e) {
                    return text(`"${action}" failed on thread ${threadId}: ${e}`);
                }
                return text(`"${action}" executed on thread ${threadId}.`);
            }

            case 'debug_console_output': {
                const lines = args.lines as number | undefined;
                const clear = args.clear as boolean | undefined;
                const output = this.readDebugOutput(lines);
                if (clear) this.clearDebugOutput();
                return text(output);
            }

            default:
                throw new Error(`Unknown tool: ${name}`);
        }
    }

    private async expandVariables(
        session: vscode.DebugSession,
        variablesReference: number,
        depth: number,
        maxDepth: number,
        indent: number,
        output: string[],
        visited = new Set<number>()
    ): Promise<void> {
        if (variablesReference === 0 || depth > maxDepth || visited.has(variablesReference)) return;
        visited.add(variablesReference);
        const resp = await session.customRequest('variables', { variablesReference });
        const vars: Array<{ name: string; value: string; variablesReference: number }> =
            resp.variables ?? [];
        const prefix = '  '.repeat(indent);
        for (const v of vars) {
            output.push(`${prefix}${v.name} = ${v.value}`);
            if (v.variablesReference > 0 && depth + 1 <= maxDepth) {
                await this.expandVariables(session, v.variablesReference, depth + 1, maxDepth, indent + 1, output, visited);
            }
        }
    }

    private formatCommandResult(result: CommandResult): string {
        let response = result.output || '(no output)';
        if (result.exitCode !== undefined) {
            response += `\n[exit code: ${result.exitCode}]`;
        }
        return response;
    }

    /**
     * Execute a shell command directly via child_process (bypassing the VS Code
     * terminal entirely). No terminal tab is shown; stdout, stderr, and the
     * exit code are captured via pipes. If `stdin` is provided it is piped to
     * the child's stdin and the stream is closed so the process can read EOF.
     */
    private async directExecute(
        command: string,
        stdin: string | undefined,
        timeoutMs: number,
        cwd: string | undefined,
        env: Record<string, string> | undefined,
        maxOutputBytes: number
    ): Promise<CommandResult> {
        const resolvedCwd = cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
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

            // Pipe stdin if provided, then close the write side so the child
            // sees EOF on its stdin.
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
                    `[execute] timeout terminal="${resolvedCwd}" command="${command.slice(0, 120)}" ` +
                    `timeoutMs=${timeoutMs} stdoutChars=${stdout.length}`
                );
                // Graceful kill first, then SIGKILL after 3s as a safety net.
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

    /**
     * Format the result of a direct (non-terminal) execution. Unlike
     * `formatCommandResult`, this shows stdout and stderr separately so callers
     * can distinguish the two streams.
     */
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
        if (result.truncated && result.maxOutputBytes !== undefined) {
            const limit = Math.round(result.maxOutputBytes / 1024);
            response += `\n\n[output truncated at ${result.maxOutputBytes} bytes (~${limit} KB) — use terminal_run to see more]`;
        }
        return response.trim() || '(no output)';
    }
}
