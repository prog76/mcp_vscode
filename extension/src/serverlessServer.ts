import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { resolveAllowedBinary } from '@vscode-mcp/shared/execPolicy';
import { WriteReport } from '@vscode-mcp/shared/types';
import { spawn, SpawnOptions } from 'child_process';
import WebSocket from 'ws';
import { TerminalManager, CommandResult } from './terminalManager';
import { PtyTerminalManager } from './ptyTerminalManager';
import { CONFIG_DEFAULTS, getTerminalRunTimeoutMs, getTerminalWaitTimeoutMs, getMaxOutputBytes, getMaxOutputBytesAction, getProgressReportIntervalMs, getTimeoutRearmOnProgress, getOutputBufferLines } from './config';
import { log } from './logger';
import { parseWsMessage, sendMessage, replaceSocket, newProgressMessage } from '@vscode-mcp/shared/wsProtocol';
import { TOOLS as SHARED_TOOLS } from '@vscode-mcp/shared/toolsSchema';

export interface ToolResult {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
    /** Machine-readable JSON payload, mirrored to MCP structuredContent. */
    structuredContent?: Record<string, unknown>;
}

// The tool catalog lives ONCE in @vscode-mcp/shared/toolsSchema and is re-exported
// here for the ws `list_tools_result` path and for extension.ts. It used to be a
// hand-maintained duplicate, which is how the `execute` schema silently drifted
// from the agent contract: the window kept advertising the old `command` form
// while the agent had moved to `binary`, so the gateway rejected every call.
export { TOOLS } from '@vscode-mcp/shared/toolsSchema';

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
                this.callTool(msg.tool, msg.params || {}, msg.requestId)
                    .then((result) => {
                        log(`[agent] callTool resolved — tool="${msg.tool}" requestId=${msg.requestId}, sending result`);
                        sendMessage(this.ws, { type: 'result', requestId: msg.requestId, result });
                    })
                    .catch((err) => {
                        log(`[agent] callTool rejected — tool="${msg.tool}" requestId=${msg.requestId}: ${err}`);
                        sendMessage(this.ws, { type: 'error', requestId: msg.requestId, message: String(err) });
                    });
                break;
            case 'list_tools':
                // Router addition to the frozen protocol: advertise the live
                // tool catalog. A peer that ignores this request keeps working
                // via the router's configured manifest.
                log(`[satellite] list_tools received — requestId=${msg.requestId}`);
                sendMessage(this.ws, { type: 'list_tools_result', requestId: msg.requestId, tools: SHARED_TOOLS });
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

    async callTool(name: string, args: Record<string, unknown>, requestId?: string): Promise<ToolResult> {
        log(`[agent] callTool start: name="${name}"`);
        const started = Date.now();
        try {
            const result = await this.invokeTool(name, args, requestId);
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

    private async invokeTool(name: string, args: Record<string, unknown>, requestId?: string): Promise<ToolResult> {
        const text = (s: string, isError = false): ToolResult => ({
            content: [{ type: 'text', text: s }],
            ...(isError ? { isError: true } : {}),
        });
        // Build a ToolResult with both a human-readable text block and a
        // machine-readable JSON payload (surfaced as MCP structuredContent).
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
                return structured(`vscode-mcp version: ${version}`, { tool: 'get_version', version });
            }

            case 'terminal_list_sessions': {
                log(`[agent] terminal_list_sessions: session="${this.sessionId}"`);
                return structured(`[hub] session="${this.sessionId}"`, { sessions: [this.sessionId] });
            }

            case 'terminal_list': {
                log(`[agent] terminal_list: session="${this.sessionId}"`);
                const terminals = this.listManagedTerminals();
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
                const engine = this.resolveTerminalEngine(terminalName);
                const wait = (args.wait as boolean | undefined) ?? true;
                const timeoutMs =
                    (args.timeout_ms as number | undefined) ?? getTerminalRunTimeoutMs();
                const stdin = args.stdin as string | undefined;
                if (engine === 'pty') {
                    if (!wait) {
                        const result = await this.ptyManager.startBackgroundExecution(command, terminalName);
                        return structured(result.message, { tool: 'terminal_run', terminal_name: terminalName ?? null, started: true, wait: false });
                    }
                    const result = await this.ptyManager.executeCommand(command, terminalName, timeoutMs);
                    return structured(this.formatCommandResult(result), this.commandResultStructured(result));
                }
                if (stdin) {
                    this.terminalManager.sendText(command, terminalName, true);
                    await new Promise((r) => setTimeout(r, 100));
                    this.terminalManager.sendText(stdin, terminalName, true);
                    return structured(`Command sent with stdin. Use terminal_wait to retrieve output.`, { tool: 'terminal_run', terminal_name: terminalName ?? null, sent: true, wait_for: 'terminal_wait' });
                }
                if (!wait) {
                    const result = await this.terminalManager.startBackgroundExecution(command, terminalName);
                    return structured(result.message, { tool: 'terminal_run', terminal_name: terminalName ?? null, started: true, wait: false });
                }
                const result = await this.terminalManager.executeCommand(command, terminalName, timeoutMs);
                return structured(this.formatCommandResult(result), this.commandResultStructured(result));
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
                let output: string;
                if (engine === 'pty') {
                    output = this.ptyManager.readOutput(terminalName, lines);
                } else {
                    output = this.terminalManager.readOutput(terminalName, lines);
                }
                return structured(output, { tool: 'terminal_read_output', terminal_name: terminalName ?? null, lines: lines ?? null, output });
            }

            case 'terminal_clear_buffer': {
                const terminalName = args.terminal_name as string | undefined;
                const engine = this.resolveTerminalEngine(terminalName);
                if (engine === 'pty') {
                    this.ptyManager.clearBuffer(terminalName);
                } else {
                    this.terminalManager.clearBuffer(terminalName);
                }
                return structured('Buffer cleared.', { tool: 'terminal_clear_buffer', terminal_name: terminalName ?? null, cleared: true });
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
                    return structured(this.formatCommandResult(result), this.commandResultStructured(result));
                }
                const result = await this.terminalManager.waitForExecution(terminalName, timeoutMs);
                return structured(this.formatCommandResult(result), this.commandResultStructured(result));
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
                const binary = args.binary as string | undefined;
                // `command` (shell form) is rejected, not ignored: the shell re-parsed
                // the payload, which is where the quoting/joining/chaining failures came
                // from. See the agent's toolCore for the same contract.
                if (args.command !== undefined) {
                    throw new Error(
                        "Parameter 'command' is no longer accepted for execute. Use " +
                        "'binary' + 'args' (no shell): cwd/env replace cd/export, " +
                        "stdout_file/stderr_file replace redirection, max_output_lines " +
                        "replaces piping through head/tail, and chaining is done with " +
                        "separate calls."
                    );
                }
                if (!binary) {
                    throw new Error("Parameter 'binary' is required for execute.");
                }
                const resolved = resolveAllowedBinary(binary);
                const argv = (args.args as string[] | undefined) ?? [];
                if (!Array.isArray(argv) || argv.some((a) => typeof a !== 'string')) {
                    throw new Error("Parameter 'args' must be an array of strings.");
                }
                log(`[agent] execute: binary="${resolved}" args=${JSON.stringify(argv)} session="${this.sessionId}"`);
                const timeoutMs =
                    (args.timeout_ms as number | undefined) ?? getTerminalRunTimeoutMs();
                const maxOutputBytes =
                    (args.max_output_bytes as number | undefined) ?? getMaxOutputBytes();
                const result = await this.argvExecute(resolved, argv, {
                    stdin: args.stdin as string | undefined,
                    stdinFile: args.stdin_file as string | undefined,
                    stdoutFile: args.stdout_file as string | undefined,
                    stderrFile: args.stderr_file as string | undefined,
                    maxOutputLines: args.max_output_lines as number | undefined,
                    timeoutMs,
                    cwd: args.cwd as string | undefined,
                    env: args.env as Record<string, string> | undefined,
                    maxOutputBytes,
                    requestId,
                });
                return structured(this.formatDirectResult(result), this.commandResultStructured(result));
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

    /** Machine-readable JSON payload for a CommandResult (mirrors exec backend shape). */
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

    /**
     * Execute a shell command directly via child_process (bypassing the VS Code
     * terminal entirely). No terminal tab is shown; stdout, stderr, and the
     * exit code are captured via pipes. If `stdin` is provided it is piped to
     * the child's stdin and the stream is closed so the process can read EOF.
     */
    /**
     * Execute an allowlisted binary with argv. No shell: the payload never becomes
     * a string something re-parses, which is what removed the quoting/joining/
     * chaining failure class (bare & forking a chain, heredoc mangling).
     */
    private async argvExecute(
        binary: string,
        argv: string[],
        opts: {
            stdin?: string;
            stdinFile?: string;
            stdoutFile?: string;
            stderrFile?: string;
            maxOutputLines?: number;
            timeoutMs: number;
            cwd?: string;
            env?: Record<string, string>;
            maxOutputBytes: number;
            requestId?: string;
        }
    ): Promise<CommandResult> {
        const resolvedCwd =
            opts.cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
        const resolvedEnv = { ...process.env, ...(opts.env ?? {}) };
        const action = getMaxOutputBytesAction();
        const progressIntervalMs = getProgressReportIntervalMs();
        const rearmOnProgress = getTimeoutRearmOnProgress();

        let stdinPayload = opts.stdin;
        if (opts.stdinFile !== undefined) {
            stdinPayload = fs.readFileSync(opts.stdinFile, 'utf8');
        }

        const report = (p: string, body: string): WriteReport => ({
            path: p,
            bytes: Buffer.byteLength(body, 'utf8'),
            lines: body.length ? body.split('\n').length : 0,
            tail: body.split('\n').slice(-10).join('\n'),
        });

        const limitLines = (body: string): { text: string; truncatedLines: number } => {
            const cap = opts.maxOutputLines;
            if (!cap || cap <= 0) {
                return { text: body, truncatedLines: 0 };
            }
            const all = body.split('\n');
            if (all.length <= cap) {
                return { text: body, truncatedLines: 0 };
            }
            const headCount = Math.ceil(cap / 2);
            const tailCount = cap - headCount;
            const omitted = all.length - cap;
            const head = all.slice(0, headCount);
            const tail = tailCount > 0 ? all.slice(-tailCount) : [];
            const joined = [...head, `[... ${omitted} lines omitted ...]`, ...tail].join('\n');
            return { text: joined, truncatedLines: omitted };
        };

        return new Promise<CommandResult>((resolve) => {
            let stdout = '';
            let stderr = '';
            let settled = false;
            let truncated = false;
            let stopCapturing = false;
            let lastOutputBytes = 0;
            let deadline = Date.now() + opts.timeoutMs;

            const options: SpawnOptions = {
                shell: false,
                cwd: resolvedCwd,
                env: resolvedEnv,
                stdio: ['pipe', 'pipe', 'pipe'],
            };

            let child: any;
            try {
                child = spawn(binary, argv, options);
            } catch (err: any) {
                resolve({
                    output: `Failed to spawn ${binary}: ${err?.message ?? err}`,
                    exitCode: undefined,
                    timedOut: false,
                });
                return;
            }

            const onChunk = (buf: Buffer, which: 'out' | 'err') => {
                if (!stopCapturing) {
                    if (which === 'out') {
                        stdout += buf.toString();
                    } else {
                        stderr += buf.toString();
                    }
                }
                if (stdout.length + stderr.length > opts.maxOutputBytes && !truncated) {
                    truncated = true;
                    if (action === 'stop-capturing') {
                        stopCapturing = true;
                    } else {
                        child.kill('SIGTERM');
                    }
                }
            };

            child.stdout?.on('data', (b: Buffer) => onChunk(b, 'out'));
            child.stderr?.on('data', (b: Buffer) => onChunk(b, 'err'));

            const progressTimer = setInterval(() => {
                if (settled) return;
                const total = stdout.length + stderr.length;
                if (rearmOnProgress && total > lastOutputBytes) {
                    lastOutputBytes = total;
                    deadline = Date.now() + opts.timeoutMs;
                }
            }, progressIntervalMs);

            const finish = (exitCode: number | undefined, timedOut: boolean) => {
                if (settled) return;
                settled = true;
                clearInterval(progressTimer);

                const written: WriteReport[] = [];
                let outText = stdout;
                let errText = stderr;

                if (opts.stdoutFile !== undefined) {
                    fs.writeFileSync(opts.stdoutFile, stdout);
                    written.push(report(opts.stdoutFile, stdout));
                    outText = '';
                }
                if (opts.stderrFile !== undefined) {
                    fs.writeFileSync(opts.stderrFile, stderr);
                    written.push(report(opts.stderrFile, stderr));
                    errText = '';
                }

                const limited = limitLines(outText);
                const limitedErr = limitLines(errText);

                resolve({
                    output: limited.text === '' ? '(no output)' : limited.text,
                    exitCode,
                    timedOut,
                    stderr: limitedErr.text,
                    timeoutMs: opts.timeoutMs,
                    truncated,
                    maxOutputBytes: opts.maxOutputBytes,
                    outputLines: outText.length ? outText.split('\n').length : 0,
                    truncatedLines: limited.truncatedLines,
                    written: written.length ? written : undefined,
                });
            };

            if (stdinPayload !== undefined) {
                child.stdin?.write(stdinPayload, (err: any) => {
                    if (err) {
                        log(`[execute] stdin write error: ${err}`);
                    }
                });
            }
            child.stdin?.end();

            const checkTimeout = () => {
                if (settled) return;
                if (Date.now() >= deadline) {
                    child.kill('SIGTERM');
                    setTimeout(() => {
                        try {
                            child.kill('SIGKILL');
                        } catch {
                            /* already gone */
                        }
                    }, 3000);
                    finish(undefined, true);
                }
            };
            const timeoutTimer = setInterval(checkTimeout, 250);

            child.on('error', (err: any) => {
                clearInterval(timeoutTimer);
                resolve({
                    output: `Failed to spawn ${binary}: ${err?.message ?? err}`,
                    exitCode: undefined,
                    timedOut: false,
                });
            });

            child.on('close', (code: number | null) => {
                clearInterval(timeoutTimer);
                finish(code === null ? undefined : code, false);
            });
        });
    }

    private async directExecute(
        command: string,
        stdin: string | undefined,
        timeoutMs: number,
        cwd: string | undefined,
        env: Record<string, string> | undefined,
        maxOutputBytes: number,
        requestId?: string
    ): Promise<CommandResult> {
        const resolvedCwd = cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
        const resolvedEnv = { ...process.env, ...(env ?? {}) };
        const action = getMaxOutputBytesAction();
        const progressIntervalMs = getProgressReportIntervalMs();
        const rearmOnProgress = getTimeoutRearmOnProgress();

        return new Promise<CommandResult>((resolve) => {
            let stdout = '';
            let stderr = '';
            let resolved = false;
            let truncated = false;
            let stopCapturing = false;
            let lastOutputBytes = 0;
            let deadline = Date.now() + timeoutMs;

            const options: SpawnOptions = {
                shell: true,
                cwd: resolvedCwd,
                env: resolvedEnv,
                stdio: ['pipe', 'pipe', 'pipe'],
            };

            const child = spawn(command, [], options);

            const onData = (buf: Buffer) => {
                if (!stopCapturing) {
                    stdout += buf.toString();
                }
                const totalBytes = stdout.length + stderr.length;
                if (totalBytes > maxOutputBytes && !truncated) {
                    truncated = true;
                    if (action === 'stop-capturing') {
                        stopCapturing = true;
                    } else {
                        child.kill('SIGTERM');
                    }
                }
            };
            const onErr = (buf: Buffer) => {
                if (!stopCapturing) {
                    stderr += buf.toString();
                }
                const totalBytes = stdout.length + stderr.length;
                if (totalBytes > maxOutputBytes && !truncated) {
                    truncated = true;
                    if (action === 'stop-capturing') {
                        stopCapturing = true;
                    } else {
                        child.kill('SIGTERM');
                    }
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

            // Progress + idle-based timeout rearm: on each interval, if output
            // bytes grew, reset the deadline and send a progress notification
            // to the hub (which may also rearm its own deadline).
            const progressTimer = setInterval(() => {
                if (resolved) return;
                const totalBytes = stdout.length + stderr.length;
                if (rearmOnProgress && totalBytes > lastOutputBytes) {
                    lastOutputBytes = totalBytes;
                    deadline = Date.now() + timeoutMs;
                    if (requestId && this.ws) {
                        sendMessage(this.ws, newProgressMessage(requestId, totalBytes));
                    }
                }
            }, progressIntervalMs);

            const checkTimeout = () => {
                if (resolved) return;
                if (Date.now() >= deadline) {
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
                    clearInterval(progressTimer);
                    resolve({
                        output: stdout || '(no output)',
                        exitCode: undefined,
                        timedOut: true,
                        stderr,
                        timeoutMs,
                        truncated,
                        maxOutputBytes,
                    });
                }
            };

            // Check timeout at half the interval for responsiveness
            const timeoutChecker = setInterval(checkTimeout, Math.min(progressIntervalMs / 2, 1000));

            child.on('error', (err: Error) => {
                if (resolved) return;
                resolved = true;
                clearInterval(progressTimer);
                clearInterval(timeoutChecker);
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
                clearInterval(progressTimer);
                clearInterval(timeoutChecker);
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
