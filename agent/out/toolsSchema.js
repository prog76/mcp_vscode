"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TOOLS = void 0;
const config_1 = require("./config");
/**
 * Verbatim copy of the TOOLS schema from extension/src/serverlessServer.ts
 * (generated; do not edit by hand - re-copy when the extension schema changes).
 * Keeping the schema byte-identical means hubs and gateway policies need no
 * changes for standalone sessions; unsupported tools return not-implemented
 * errors from toolCore.ts rather than being removed from the schema.
 */
exports.TOOLS = [
    {
        name: 'get_version',
        description: 'Get the version of the vscode-mcp extension (read from package.json at runtime).',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'terminal_create',
        description: 'Create a new terminal explicitly. Use this when you need a fresh terminal with specific settings.\n' +
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
        description: 'Lists all connected VS Code windows with their session IDs (= workspace folder name). ' +
            'Identify your session by matching the workspace folder name visible in your current context, ' +
            'then remember that session_id and pass it to all subsequent terminal tool calls.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'terminal_list',
        description: 'List terminals created via terminal_create in this session. With session_id lists terminals in that session only.\n' +
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
        description: 'Execute a shell command in a VS Code terminal and capture output.\n' +
            'Blocks until the command finishes or timeout_ms elapses.\n' +
            'Default timeout_ms = vscode-mcp.terminalRunTimeoutMs from extension settings ' +
            `(package.json default ${config_1.CONFIG_DEFAULTS.terminalRunTimeoutMs}).\n` +
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
                    description: 'Hard wait in milliseconds. Optional; default is vscode-mcp.terminalRunTimeoutMs ' +
                        `(${config_1.CONFIG_DEFAULTS.terminalRunTimeoutMs}). On expiry: command keeps running; ` +
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
            'output and exit code. Blocks up to timeout_ms.\n' +
            'Default timeout_ms = vscode-mcp.terminalWaitTimeoutMs from extension settings ' +
            `(package.json default ${config_1.CONFIG_DEFAULTS.terminalWaitTimeoutMs}).\n` +
            'On timeout: WAIT timeout (not transport failure). Returns output accumulated during this wait ' +
            'with \'[STILL RUNNING — ...]\'. Call again to continue waiting, or send \'\\x03\' via terminal_send_text to abort. ' +
            'Do not re-run the original mutating command.',
        inputSchema: {
            type: 'object',
            properties: {
                terminal_name: { type: 'string', description: 'Name of a terminal created via terminal_create.' },
                timeout_ms: {
                    type: 'number',
                    description: 'Max milliseconds to block. Optional; default is vscode-mcp.terminalWaitTimeoutMs ' +
                        `(${config_1.CONFIG_DEFAULTS.terminalWaitTimeoutMs}). On expiry: [STILL RUNNING]; call again — not a transport error.`,
                },
                session_id: { type: 'string', description: 'Target session ID (workspace name).' },
            },
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
        name: 'execute',
        description: 'Execute a shell command directly (NOT via VS Code terminal) and capture output.\n' +
            'Spawns a child process with stdio pipes — no terminal tab is shown. ' +
            'stdout, stderr, and exit code are captured and returned.\n' +
            'stdin is piped to the process if provided.\n' +
            'Default timeout_ms = vscode-mcp.terminalRunTimeoutMs from extension settings ' +
            `(package.json default ${config_1.CONFIG_DEFAULTS.terminalRunTimeoutMs}).\n` +
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
                    description: 'Hard timeout in milliseconds. Optional; default is vscode-mcp.terminalRunTimeoutMs ' +
                        `(${config_1.CONFIG_DEFAULTS.terminalRunTimeoutMs}). On expiry: process is killed, partial output returned.`,
                },
                env: {
                    type: 'object',
                    description: 'Additional environment variables merged on top of the current process.env (optional)',
                    additionalProperties: true,
                },
                max_output_bytes: {
                    type: 'number',
                    description: 'Max combined stdout+stderr size in bytes before truncation. Optional; ' +
                        `default is vscode-mcp.maxOutputBytes (${config_1.CONFIG_DEFAULTS.maxOutputBytes}). ` +
                        'If output exceeds this, the process is killed and output is truncated.',
                },
                session_id: { type: 'string', description: 'Target session ID (workspace name).' },
            },
            required: ['command'],
        },
    },
    {
        name: 'open_file',
        description: 'Open a file in the VS Code editor and optionally jump to a line or highlight a range. ' +
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
//# sourceMappingURL=toolsSchema.js.map