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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ServerlessServer = exports.TOOLS = void 0;
const vscode = __importStar(require("vscode"));
const ws_1 = __importDefault(require("ws"));
const logger_1 = require("./logger");
exports.TOOLS = [
    {
        name: 'terminal_create',
        description: 'Create a new terminal explicitly. Use this when you need a fresh terminal with specific settings.\n' +
            'engine=shell uses VS Code shell integration (default). engine=pty uses node-pty fallback.\n' +
            'Returns the created terminal name and engine used (shell-integration or pty-fallback).',
        inputSchema: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Terminal name' },
                cwd: { type: 'string', description: 'Working directory path' },
                engine: { type: 'string', enum: ['auto', 'shell', 'pty'], description: 'Terminal engine (default: auto)' },
                shell: { type: 'string', description: 'Shell executable path/name (optional)' },
                session_id: { type: 'string', description: 'Target session ID (workspace name).' },
            },
            required: ['name'],
        },
    },
    {
        name: 'terminal_list_sessions',
        description: 'Lists all connected VS Code windows with their session IDs (= workspace folder name). ' +
            'Identify your session by matching the workspace folder name visible in your current context, ' +
            'then remember that session_id and pass it to all subsequent terminal tool calls.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'terminal_list',
        description: 'List open VS Code terminals. With session_id lists terminals in that session only.\n' +
            'Each terminal shows its engine: [shell-integration] or [no shell-integration].',
        inputSchema: {
            type: 'object',
            properties: {
                session_id: { type: 'string', description: 'Target session ID (workspace name).' },
            },
        },
    },
    {
        name: 'terminal_run',
        description: 'Execute a shell command in a VS Code terminal and capture output.\n' +
            'Blocks until the command finishes or timeout_ms elapses (default 300000 = 5 min). On timeout, ' +
            'the command keeps running and the response ends with \'[STILL RUNNING — ...]\' — call terminal_wait to resume.\n' +
            'For commands expected to exceed ~30s, prefer wait=false + progressive terminal_wait calls.\n' +
            'Returns final output with \'[exit code: N]\' on success.\n' +
            'If terminal_name is omitted and no active terminal exists, a new terminal is auto-created and the response includes the engine used (shell-integration or pty-fallback).',
        inputSchema: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'Shell command to execute' },
                terminal_name: { type: 'string', description: 'Name of target terminal (optional)' },
                timeout_ms: { type: 'number', description: 'Hard timeout in milliseconds (default: 300000)' },
                wait: { type: 'boolean', description: 'Wait for output (default: true)' },
                session_id: { type: 'string', description: 'Target session ID (workspace name).' },
            },
            required: ['command'],
        },
    },
    {
        name: 'terminal_send_text',
        description: 'Send text/input to a terminal WITHOUT capturing output. Works on busy terminals — this is ' +
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
        description: 'Read raw buffered output from a terminal (no exit code, includes user-typed command output too). ' +
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
        description: 'Wait for the current (or most recent) execution in a terminal to finish, and return its ' +
            'output and exit code. Blocks up to timeout_ms (default 300000). On timeout, returns output ' +
            'accumulated during this wait with \'[STILL RUNNING — ...]\' — call again to continue waiting, ' +
            'or send \'\\x03\' via terminal_send_text to abort.',
        inputSchema: {
            type: 'object',
            properties: {
                terminal_name: { type: 'string', description: 'Name of target terminal (required).' },
                timeout_ms: { type: 'number', description: 'Max milliseconds to block (default: 300000).' },
                session_id: { type: 'string', description: 'Target session ID (workspace name).' },
            },
            required: ['terminal_name'],
        },
    },
    {
        name: 'get_diagnostics',
        description: 'Get VS Code diagnostics (errors, warnings, hints) from all open files or a specific file.',
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
        description: 'Get the symbol outline of a file (functions, classes, methods, variables, exports) without reading the entire file.',
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
        description: 'Find all references (usages) of a symbol across the entire workspace.',
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
        description: 'Rename a symbol across the entire workspace using VS Code LSP.',
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
        description: 'Execute any VS Code command by ID. Universal escape hatch — anything VS Code can do, the agent can trigger.',
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
        name: 'open_file',
        description: 'Open a file in the VS Code editor and optionally jump to a line or highlight a range.',
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
        description: 'Format a file using the configured formatter (Prettier, ESLint, etc.) and save it.',
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
        description: 'Remove unused imports and sort remaining imports in a file, then save.',
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
        description: 'Apply all auto-fixable diagnostics in a file (ESLint auto-fixes, missing semicolons, etc.) and save it.',
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
        description: 'Open the VS Code workspace search panel with a query.',
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
        description: 'Get type information, documentation, and signatures for a symbol at a specific position.',
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
        description: 'Add, remove, list, or clear breakpoints. Works without an active debug session.',
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
        description: 'Start a debug session. Provide either a launch.json config name or an inline config object.',
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
        description: 'Stop a debug session. By default stops the active session; set all=true to stop every session.',
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
        description: 'Get a full snapshot of the current debug state: threads, call stacks, scopes, and variables — all in one call.',
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
        description: 'Control execution of a debug session: continue, pause, step over/into/out, restart, or evaluate expressions.',
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
        description: 'Read debug console output (console.log, stderr, debugger messages) from the current or most recent debug session.',
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
class ServerlessServer {
    constructor(terminalManager, ptyManager, sessionId, terminalEngine = 'auto', maxDebugOutputLines = 2000) {
        this.debugOutputBuffer = [];
        this.ws = null;
        this.wsUrl = null;
        this.reconnectTimer = null;
        this.hubLostCallback = null;
        this.intentionallyStopped = false;
        this.port = 0;
        this.terminalManager = terminalManager;
        this.ptyManager = ptyManager;
        this.sessionId = sessionId;
        this.terminalEngine = terminalEngine;
        this.maxDebugOutputLines = maxDebugOutputLines;
    }
    get isRunning() {
        return true;
    }
    /** Register a callback invoked when the hub connection is lost. */
    onHubLost(callback) {
        this.hubLostCallback = callback;
    }
    /** Connect to the hub as a satellite via WebSocket. */
    async connectAsSatellite(wsUrl) {
        (0, logger_1.log)(`[satellite] connectAsSatellite(${wsUrl}) — session="${this.sessionId}"`);
        this.wsUrl = wsUrl;
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        let hubLostAlreadyCalled = false;
        await new Promise((resolve, reject) => {
            const ws = new ws_1.default(wsUrl);
            const onOpen = () => {
                this.ws = ws;
                (0, logger_1.log)(`[satellite] WebSocket open, sending register for session="${this.sessionId}"`);
                ws.send(JSON.stringify({ type: 'register', sessionId: this.sessionId }));
                resolve();
            };
            const onClose = () => {
                (0, logger_1.log)(`[satellite] WebSocket closed — scheduling reconnect`);
                this.ws = null;
                if (!this.intentionallyStopped && this.wsUrl) {
                    (0, logger_1.log)(`[satellite] scheduling reconnect in 2000ms`);
                    this.reconnectTimer = setTimeout(() => {
                        this.connectAsSatellite(this.wsUrl).catch(() => { });
                    }, 2000);
                }
                if (!hubLostAlreadyCalled) {
                    hubLostAlreadyCalled = true;
                    this.hubLostCallback?.();
                }
            };
            ws.on('open', onOpen);
            ws.on('message', (data) => this.handleMessage(data));
            ws.on('close', onClose);
            ws.on('error', (err) => {
                (0, logger_1.log)(`[satellite] WebSocket error: ${err}`);
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
    }
    handleMessage(data) {
        let msg;
        try {
            msg = JSON.parse(data.toString());
        }
        catch {
            return;
        }
        switch (msg.type) {
            case 'execute':
                (0, logger_1.log)(`[satellite] execute received — tool="${msg.tool}" requestId=${msg.requestId}`);
                this.callTool(msg.tool, msg.params || {})
                    .then((result) => {
                    (0, logger_1.log)(`[agent] callTool resolved — tool="${msg.tool}" requestId=${msg.requestId}, sending result`);
                    this.ws?.send(JSON.stringify({ type: 'result', requestId: msg.requestId, result }));
                })
                    .catch((err) => {
                    (0, logger_1.log)(`[agent] callTool rejected — tool="${msg.tool}" requestId=${msg.requestId}: ${err}`);
                    this.ws?.send(JSON.stringify({ type: 'error', requestId: msg.requestId, message: String(err) }));
                });
                break;
            case 'ping':
                this.ws?.send(JSON.stringify({ type: 'pong' }));
                break;
        }
    }
    stop() {
        this.intentionallyStopped = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.wsUrl = null;
    }
    usePtyFallback() {
        return this.terminalEngine === 'force-fallback';
    }
    appendDebugOutput(output, category) {
        const prefix = category && category !== 'stdout' ? `[${category}] ` : '';
        const lines = output.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].replace(/\r$/, '');
            if (i === lines.length - 1 && line === '')
                continue;
            this.debugOutputBuffer.push(prefix + line);
        }
        if (this.debugOutputBuffer.length > this.maxDebugOutputLines) {
            this.debugOutputBuffer.splice(0, this.debugOutputBuffer.length - this.maxDebugOutputLines);
        }
    }
    readDebugOutput(lines) {
        if (this.debugOutputBuffer.length === 0)
            return '(no debug output)';
        const slice = lines ? this.debugOutputBuffer.slice(-lines) : this.debugOutputBuffer;
        return slice.join('\n');
    }
    clearDebugOutput() {
        this.debugOutputBuffer = [];
    }
    async callTool(name, args) {
        (0, logger_1.log)(`[agent] callTool start: name="${name}"`);
        const text = (s) => ({ content: [{ type: 'text', text: s }] });
        switch (name) {
            case 'terminal_list_sessions': {
                (0, logger_1.log)(`[agent] terminal_list_sessions: session="${this.sessionId}"`);
                return text(`[hub] session="${this.sessionId}"`);
            }
            case 'terminal_list': {
                (0, logger_1.log)(`[agent] terminal_list: session="${this.sessionId}"`);
                const terminals = this.terminalManager.listTerminals();
                if (terminals.length === 0)
                    return text('No terminals open.');
                const lines = terminals.map((t) => `[${t.id}] "${t.name}"${t.isActive ? ' (active)' : ''}${t.hasShellIntegration ? ' [shell-integration]' : ' [no shell-integration]'}`);
                return text(lines.join('\n'));
            }
            case 'terminal_run': {
                (0, logger_1.log)(`[agent] terminal_run: command="${args.command}" session="${this.sessionId}"`);
                const command = args.command;
                const terminalName = args.terminal_name;
                const wait = args.wait ?? true;
                const timeoutMs = args.timeout_ms ?? 300000;
                const stdin = args.stdin;
                if (this.usePtyFallback()) {
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
                (0, logger_1.log)(`[agent] terminal_create: name="${args.name}" session="${this.sessionId}"`);
                const name = args.name;
                const cwd = args.cwd;
                const engine = args.engine;
                const shell = args.shell;
                const usePty = engine === 'pty' || (engine === 'auto' && this.usePtyFallback());
                let result;
                if (usePty) {
                    result = this.ptyManager.createTerminal(name, cwd, shell);
                }
                else {
                    result = await this.terminalManager.createTerminal(name, cwd, shell);
                }
                return text(`Created terminal "${result.terminalName}" (engine: ${result.engine})`);
            }
            case 'terminal_send_text': {
                const rawText = args.text;
                const processed = rawText
                    .replace(/\\x03/g, '\x03')
                    .replace(/\\x04/g, '\x04')
                    .replace(/\\n/g, '\n');
                const terminalName = args.terminal_name;
                const addNewline = args.add_newline ?? true;
                if (this.usePtyFallback()) {
                    this.ptyManager.sendText(processed, terminalName, addNewline);
                }
                else {
                    this.terminalManager.sendText(processed, terminalName, addNewline);
                }
                return text(`Text sent to terminal${terminalName ? ` "${terminalName}"` : ''}.`);
            }
            case 'terminal_read_output': {
                const terminalName = args.terminal_name;
                const lines = args.lines;
                if (this.usePtyFallback()) {
                    return text(this.ptyManager.readOutput(terminalName, lines));
                }
                return text(this.terminalManager.readOutput(terminalName, lines));
            }
            case 'terminal_clear_buffer': {
                const terminalName = args.terminal_name;
                if (this.usePtyFallback()) {
                    this.ptyManager.clearBuffer(terminalName);
                }
                else {
                    this.terminalManager.clearBuffer(terminalName);
                }
                return text('Buffer cleared.');
            }
            case 'terminal_wait': {
                const terminalName = args.terminal_name;
                if (!terminalName) {
                    throw new Error("terminal_wait requires 'terminal_name'.");
                }
                const timeoutMs = args.timeout_ms ?? 300000;
                if (this.usePtyFallback()) {
                    const result = await this.ptyManager.waitForExecution(terminalName, timeoutMs);
                    return text(this.formatCommandResult(result));
                }
                const result = await this.terminalManager.waitForExecution(terminalName, timeoutMs);
                return text(this.formatCommandResult(result));
            }
            case 'get_diagnostics': {
                const uri = args.uri;
                const severity = args.severity;
                const severityMap = {
                    error: vscode.DiagnosticSeverity.Error,
                    warning: vscode.DiagnosticSeverity.Warning,
                    information: vscode.DiagnosticSeverity.Information,
                    hint: vscode.DiagnosticSeverity.Hint,
                };
                const severityNames = {
                    [vscode.DiagnosticSeverity.Error]: 'Error',
                    [vscode.DiagnosticSeverity.Warning]: 'Warning',
                    [vscode.DiagnosticSeverity.Information]: 'Information',
                    [vscode.DiagnosticSeverity.Hint]: 'Hint',
                };
                const filterSeverity = severity ? severityMap[severity] : undefined;
                let allDiagnostics;
                if (uri) {
                    const fileUri = uri.includes('://') ? vscode.Uri.parse(uri) : vscode.Uri.file(uri);
                    const diags = vscode.languages.getDiagnostics(fileUri);
                    allDiagnostics = diags.length > 0 ? [[fileUri, diags]] : [];
                }
                else {
                    allDiagnostics = vscode.languages.getDiagnostics();
                }
                const lines = [];
                let totalCount = 0;
                for (const [fileUri, diagnostics] of allDiagnostics) {
                    const filtered = filterSeverity !== undefined
                        ? diagnostics.filter((d) => d.severity === filterSeverity)
                        : diagnostics;
                    if (filtered.length === 0)
                        continue;
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
                const uri = args.uri;
                const fileUri = uri.includes('://') ? vscode.Uri.parse(uri) : vscode.Uri.file(uri);
                const symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', fileUri);
                if (!symbols || symbols.length === 0) {
                    return text(`No symbols found in ${uri}. The file may not have a language server active.`);
                }
                const symbolKindName = (kind) => vscode.SymbolKind[kind] || 'Unknown';
                const lines = [];
                const walk = (syms, indent) => {
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
                const uri = args.uri;
                const line = args.line;
                const character = args.character;
                if (!Number.isInteger(line) || !Number.isInteger(character) || line < 0 || character < 0) {
                    return text('Error: line and character must be non-negative integers.');
                }
                const fileUri = uri.includes('://') ? vscode.Uri.parse(uri) : vscode.Uri.file(uri);
                const position = new vscode.Position(line, character);
                const locations = await vscode.commands.executeCommand('vscode.executeReferenceProvider', fileUri, position);
                if (!locations || locations.length === 0) {
                    return text(`No references found at ${uri}:${line}:${character}.`);
                }
                const MAX_REFS = 500;
                const lines = locations.map((loc) => {
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
                const uri = args.uri;
                const line = args.line;
                const character = args.character;
                if (!Number.isInteger(line) || !Number.isInteger(character) || line < 0 || character < 0) {
                    return text('Error: line and character must be non-negative integers.');
                }
                const newName = args.new_name;
                const fileUri = uri.includes('://') ? vscode.Uri.parse(uri) : vscode.Uri.file(uri);
                const position = new vscode.Position(line, character);
                let prepareResult;
                try {
                    prepareResult = await vscode.commands.executeCommand('vscode.prepareRename', fileUri, position);
                }
                catch (prepErr) {
                    return text(`Cannot rename at ${uri}:${line}:${character} — ${prepErr}`);
                }
                if (!prepareResult) {
                    return text(`Cannot rename symbol at ${uri}:${line}:${character}. The element at this position is not renameable.`);
                }
                const edit = await vscode.commands.executeCommand('vscode.executeDocumentRenameProvider', fileUri, position, newName);
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
                    if (doc.isDirty) {
                        await doc.save();
                    }
                }
                return text(`Renamed to "${newName}" — ${totalEdits} edit(s) across ${entries.length} file(s):\n${fileList.join('\n')}`);
            }
            case 'run_command': {
                const command = args.command;
                const commandArgs = args.args;
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
                }
                catch (e) {
                    return text(`Command "${command}" failed: ${e}`);
                }
            }
            case 'open_file': {
                const file = args.file;
                const line = args.line;
                const endLine = args.end_line;
                const fileUri = file.includes('://') ? vscode.Uri.parse(file) : vscode.Uri.file(file);
                const doc = await vscode.workspace.openTextDocument(fileUri);
                const editor = await vscode.window.showTextDocument(doc);
                if (line !== undefined) {
                    const startLine = Math.min(Math.max(line - 1, 0), doc.lineCount - 1);
                    const startPos = new vscode.Position(startLine, 0);
                    const endPos = endLine
                        ? new vscode.Position(Math.min(endLine - 1, doc.lineCount - 1), doc.lineAt(Math.min(endLine - 1, doc.lineCount - 1)).text.length)
                        : startPos;
                    editor.revealRange(new vscode.Range(startPos, endPos), vscode.TextEditorRevealType.InCenter);
                    editor.selection = new vscode.Selection(startPos, endPos);
                }
                const rel = vscode.workspace.asRelativePath(fileUri);
                return text(`Opened ${rel}${line ? ` at line ${line}` : ''}${endLine ? `–${endLine}` : ''}`);
            }
            case 'format_document': {
                const file = args.file;
                const fileUri = file.includes('://') ? vscode.Uri.parse(file) : vscode.Uri.file(file);
                const config = vscode.workspace.getConfiguration('editor', fileUri);
                const options = {
                    tabSize: config.get('tabSize', 4),
                    insertSpaces: config.get('insertSpaces', true),
                };
                const edits = await vscode.commands.executeCommand('vscode.executeFormatDocumentProvider', fileUri, options);
                if (!edits || edits.length === 0) {
                    return text(`No formatting changes needed for ${vscode.workspace.asRelativePath(fileUri)}.`);
                }
                const wsEdit = new vscode.WorkspaceEdit();
                for (const edit of edits) {
                    wsEdit.replace(fileUri, edit.range, edit.newText);
                }
                await vscode.workspace.applyEdit(wsEdit);
                const doc = await vscode.workspace.openTextDocument(fileUri);
                if (doc.isDirty)
                    await doc.save();
                return text(`Formatted ${vscode.workspace.asRelativePath(fileUri)} (${edits.length} edit(s) applied).`);
            }
            case 'organize_imports': {
                const file = args.file;
                const fileUri = file.includes('://') ? vscode.Uri.parse(file) : vscode.Uri.file(file);
                const doc = await vscode.workspace.openTextDocument(fileUri);
                const fullRange = doc.validateRange(new vscode.Range(0, 0, doc.lineCount, 0));
                const actions = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', fileUri, fullRange, vscode.CodeActionKind.SourceOrganizeImports.value);
                if (!actions || actions.length === 0) {
                    return text(`No import changes needed for ${vscode.workspace.asRelativePath(fileUri)}.`);
                }
                for (const action of actions) {
                    if (action.edit) {
                        await vscode.workspace.applyEdit(action.edit);
                    }
                }
                if (doc.isDirty)
                    await doc.save();
                return text(`Organized imports in ${vscode.workspace.asRelativePath(fileUri)}.`);
            }
            case 'fix_all': {
                const file = args.file;
                const fileUri = file.includes('://') ? vscode.Uri.parse(file) : vscode.Uri.file(file);
                const doc = await vscode.workspace.openTextDocument(fileUri);
                const fullRange = doc.validateRange(new vscode.Range(0, 0, doc.lineCount, 0));
                const actions = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', fileUri, fullRange, vscode.CodeActionKind.SourceFixAll.value);
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
                if (doc.isDirty)
                    await doc.save();
                return text(`Applied ${fixCount} fix(es) in ${vscode.workspace.asRelativePath(fileUri)}.`);
            }
            case 'save_all': {
                await vscode.workspace.saveAll(false);
                return text('All files saved.');
            }
            case 'find_in_files': {
                const query = args.query;
                const replace = args.replace;
                const isRegex = args.is_regex;
                const include = args.include;
                const exclude = args.exclude;
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
                const uri = args.uri;
                const line = args.line;
                const character = args.character;
                const fileUri = uri.includes('://') ? vscode.Uri.parse(uri) : vscode.Uri.file(uri);
                const position = new vscode.Position(line, character);
                const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', fileUri, position);
                if (!hovers || hovers.length === 0) {
                    return text(`No hover info at ${vscode.workspace.asRelativePath(fileUri)}:${line}:${character}.`);
                }
                const parts = [];
                for (const hover of hovers) {
                    for (const content of hover.contents) {
                        if (typeof content === 'string') {
                            parts.push(content);
                        }
                        else if ('value' in content) {
                            parts.push(content.value);
                        }
                    }
                }
                return text(parts.join('\n\n'));
            }
            case 'debug_breakpoints': {
                const action = args.action;
                if (action === 'list') {
                    const bps = vscode.debug.breakpoints;
                    if (bps.length === 0)
                        return text('No breakpoints set.');
                    const lines = [];
                    for (const bp of bps) {
                        if (bp instanceof vscode.SourceBreakpoint) {
                            const loc = bp.location;
                            const rel = vscode.workspace.asRelativePath(loc.uri);
                            const line = loc.range.start.line + 1;
                            let desc = `${rel}:${line}`;
                            if (bp.condition)
                                desc += ` condition="${bp.condition}"`;
                            if (bp.hitCondition)
                                desc += ` hitCondition="${bp.hitCondition}"`;
                            if (bp.logMessage)
                                desc += ` log="${bp.logMessage}"`;
                            if (!bp.enabled)
                                desc += ' (disabled)';
                            lines.push(desc);
                        }
                        else if (bp instanceof vscode.FunctionBreakpoint) {
                            let desc = `function: ${bp.functionName}`;
                            if (bp.condition)
                                desc += ` condition="${bp.condition}"`;
                            if (!bp.enabled)
                                desc += ' (disabled)';
                            lines.push(desc);
                        }
                    }
                    return text(`${lines.length} breakpoint(s):\n${lines.join('\n')}`);
                }
                if (action === 'clear') {
                    const bps = vscode.debug.breakpoints;
                    if (bps.length === 0)
                        return text('No breakpoints to clear.');
                    vscode.debug.removeBreakpoints(bps);
                    return text(`Cleared ${bps.length} breakpoint(s).`);
                }
                const file = args.file;
                const line = args.line;
                if (!file || line === undefined) {
                    return text('Error: "file" and "line" are required for add/remove.');
                }
                const fileUri = file.includes('://') ? vscode.Uri.parse(file) : vscode.Uri.file(file);
                const position = new vscode.Position(line - 1, 0);
                const location = new vscode.Location(fileUri, position);
                if (action === 'add') {
                    const bp = new vscode.SourceBreakpoint(location, true, args.condition, args.hit_condition, args.log_message);
                    vscode.debug.addBreakpoints([bp]);
                    const rel = vscode.workspace.asRelativePath(fileUri);
                    return text(`Breakpoint added: ${rel}:${line}`);
                }
                if (action === 'remove') {
                    const match = vscode.debug.breakpoints.find((bp) => bp instanceof vscode.SourceBreakpoint &&
                        bp.location.uri.fsPath === fileUri.fsPath &&
                        bp.location.range.start.line === line - 1);
                    if (!match) {
                        return text(`No breakpoint found at ${vscode.workspace.asRelativePath(fileUri)}:${line}.`);
                    }
                    vscode.debug.removeBreakpoints([match]);
                    return text(`Breakpoint removed: ${vscode.workspace.asRelativePath(fileUri)}:${line}`);
                }
                return text(`Unknown breakpoint action: "${action}". Use add, remove, list, or clear.`);
            }
            case 'debug_start': {
                const configName = args.name;
                const inlineConfig = args.config;
                const folder = vscode.workspace.workspaceFolders?.[0];
                let started;
                if (inlineConfig) {
                    started = await vscode.debug.startDebugging(folder, inlineConfig);
                }
                else if (configName) {
                    started = await vscode.debug.startDebugging(folder, configName);
                }
                else {
                    started = await vscode.debug.startDebugging(folder, undefined);
                }
                if (!started) {
                    return text('Failed to start debug session. Check that a valid launch configuration exists.');
                }
                await new Promise((r) => setTimeout(r, 500));
                const session = vscode.debug.activeDebugSession;
                return text(`Debug session started: "${session?.name ?? 'unknown'}" (type: ${session?.type ?? 'unknown'})`);
            }
            case 'debug_stop': {
                const all = args.all;
                const clearBps = args.clear_breakpoints;
                if (all) {
                    await vscode.debug.stopDebugging(undefined);
                }
                else {
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
                const targetThreadId = args.thread_id;
                const maxDepth = args.max_depth ?? 1;
                const threadsResp = await session.customRequest('threads');
                const threads = threadsResp.threads ?? [];
                if (threads.length === 0) {
                    return text('No threads available.');
                }
                const filtered = targetThreadId
                    ? threads.filter((t) => t.id === targetThreadId)
                    : threads;
                if (filtered.length === 0) {
                    return text(`Thread ${targetThreadId} not found. Available: ${threads.map((t) => t.id).join(', ')}`);
                }
                const output = [];
                for (const thread of filtered) {
                    let stackFrames = [];
                    let stoppedReason = '';
                    try {
                        const stResp = await session.customRequest('stackTrace', {
                            threadId: thread.id,
                            startFrame: 0,
                            levels: 20,
                        });
                        stackFrames = stResp.stackFrames ?? [];
                    }
                    catch {
                        stoppedReason = 'running';
                    }
                    output.push(`Thread #${thread.id} "${thread.name}"${stoppedReason ? ` (${stoppedReason})` : ''}`);
                    for (const frame of stackFrames) {
                        const src = frame.source?.path
                            ? vscode.workspace.asRelativePath(frame.source.path)
                            : frame.source?.name ?? '<unknown>';
                        output.push(`  Frame #${frame.id}: ${src}:${frame.line} in ${frame.name}`);
                        if (maxDepth < 1)
                            continue;
                        try {
                            const scopesResp = await session.customRequest('scopes', { frameId: frame.id });
                            const scopes = scopesResp.scopes ?? [];
                            for (const scope of scopes) {
                                if (scope.expensive) {
                                    output.push(`    ${scope.name}: (expensive — skipped)`);
                                    continue;
                                }
                                output.push(`    ${scope.name}:`);
                                await this.expandVariables(session, scope.variablesReference, 1, maxDepth, 3, output);
                            }
                        }
                        catch {
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
                const action = args.action;
                if (action === 'evaluate') {
                    const expression = args.expression;
                    if (!expression) {
                        return text('Error: "expression" is required for evaluate.');
                    }
                    const evalArgs = {
                        expression,
                        context: args.context ?? 'repl',
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
                let threadId = args.thread_id;
                if (threadId === undefined) {
                    const threadsResp = await session.customRequest('threads');
                    const threads = threadsResp.threads ?? [];
                    if (threads.length === 0) {
                        return text('No threads available.');
                    }
                    threadId = threads[0].id;
                }
                try {
                    await session.customRequest(action, { threadId });
                }
                catch (e) {
                    return text(`"${action}" failed on thread ${threadId}: ${e}`);
                }
                return text(`"${action}" executed on thread ${threadId}.`);
            }
            case 'debug_console_output': {
                const lines = args.lines;
                const clear = args.clear;
                const output = this.readDebugOutput(lines);
                if (clear)
                    this.clearDebugOutput();
                return text(output);
            }
            default:
                (0, logger_1.log)(`[agent] callTool done: name="${name}" -> error: Unknown tool`);
                throw new Error(`Unknown tool: ${name}`);
        }
    }
    async expandVariables(session, variablesReference, depth, maxDepth, indent, output, visited = new Set()) {
        if (variablesReference === 0 || depth > maxDepth || visited.has(variablesReference))
            return;
        visited.add(variablesReference);
        const resp = await session.customRequest('variables', { variablesReference });
        const vars = resp.variables ?? [];
        const prefix = '  '.repeat(indent);
        for (const v of vars) {
            output.push(`${prefix}${v.name} = ${v.value}`);
            if (v.variablesReference > 0 && depth + 1 <= maxDepth) {
                await this.expandVariables(session, v.variablesReference, depth + 1, maxDepth, indent + 1, output, visited);
            }
        }
    }
    formatCommandResult(result) {
        let response = result.output || '(no output)';
        if (result.exitCode !== undefined) {
            response += `\n[exit code: ${result.exitCode}]`;
        }
        return response;
    }
}
exports.ServerlessServer = ServerlessServer;
//# sourceMappingURL=serverlessServer.js.map