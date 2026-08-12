import * as vscode from 'vscode';
import { getShellReadDrainMs, getShellStartBindMs, getTerminalCreateWarmupMs } from './config';
import { log } from './logger';

export interface TerminalInfo {
    id: string;
    name: string;
    isActive: boolean;
    hasShellIntegration: boolean;
    engine: 'shell-integration' | 'pty-fallback';
}

export interface CommandResult {
    output: string;
    exitCode: number | undefined;
    timedOut: boolean;
}

interface ExecutionState {
    execution: vscode.TerminalShellExecution;
    terminalName: string;
    commandLine: string;
    startedAt: number;
    output: string;
    deliveredLength: number;
    endPromise: Promise<number | undefined>;
    resolveEnd: (exitCode: number | undefined) => void;
    finishedAt?: number;
    isOwn: boolean;
}

interface PendingOwn {
    state: ExecutionState;
    returnedExecution: vscode.TerminalShellExecution;
    resolveBound: (execution: vscode.TerminalShellExecution) => void;
}

interface RecentResult {
    undeliveredOutput: string;
    exitCode: number | undefined;
    finishedAt: number;
}

const RECENT_RESULT_TTL_MS = 60_000;
const END_EVENT_WAIT_MS = 2000;

class OutputBuffer {
    private lines: string[] = [];
    private maxLines: number;
    private partial = '';

    constructor(maxLines: number) {
        this.maxLines = maxLines;
    }

    append(data: string): void {
        const cleaned = data.replace(
            // eslint-disable-next-line no-control-regex
            /\x1b(?:\[[0-9;]*[mGKHFABCDEJsupr]|\][^\x07]*\x07|[()][AB012])|[\r]/g,
            ''
        );
        const all = this.partial + cleaned;
        if (all.length > 512 * 1024) {
            this.partial = '';
            return;
        }
        const parts = all.split('\n');
        this.partial = parts.pop() ?? '';
        for (const line of parts) {
            this.lines.push(line);
            if (this.lines.length > this.maxLines) {
                this.lines.shift();
            }
        }
    }

    flush(): void {
        if (this.partial) {
            this.lines.push(this.partial);
            this.partial = '';
        }
    }

    getLines(count?: number): string[] {
        if (count === undefined) return [...this.lines];
        return this.lines.slice(-count);
    }

    clear(): void {
        this.lines = [];
        this.partial = '';
    }

    get lineCount(): number {
        return this.lines.length;
    }
}

export class TerminalManager {
    private outputBuffers = new Map<string, OutputBuffer>();
    private disposables: vscode.Disposable[] = [];
    private maxBufferLines: number;
    private ownExecutions = new Set<vscode.TerminalShellExecution>();
    private activeExecutions = new Map<string, ExecutionState>();
    private pendingOwnByTerminal = new Map<string, PendingOwn>();
    private recentResults = new Map<string, RecentResult>();
    /** Registry of terminal names created via terminal_create (name -> name). */
    private managedTerminals = new Map<string, string>();

    constructor(maxBufferLines: number) {
        this.maxBufferLines = maxBufferLines;
        this.setupListeners();
    }

    private getBuffer(terminal: vscode.Terminal): OutputBuffer {
        const key = terminal.name;
        if (!this.outputBuffers.has(key)) {
            this.outputBuffers.set(key, new OutputBuffer(this.maxBufferLines));
        }
        return this.outputBuffers.get(key)!;
    }

    private registerExecution(
        e: { terminal: vscode.Terminal; execution: vscode.TerminalShellExecution },
        commandLine: string,
        isOwn: boolean
    ): ExecutionState {
        let resolveEnd!: (exitCode: number | undefined) => void;
        const endPromise = new Promise<number | undefined>((resolve) => { resolveEnd = resolve; });
        const state: ExecutionState = {
            execution: e.execution,
            terminalName: e.terminal.name,
            commandLine,
            startedAt: Date.now(),
            output: '',
            deliveredLength: 0,
            endPromise,
            resolveEnd,
            isOwn,
        };
        this.activeExecutions.set(e.terminal.name, state);
        return state;
    }

    private setupListeners(): void {
        this.disposables.push(
            vscode.window.onDidStartTerminalShellExecution(async (e) => {
                const pending = this.pendingOwnByTerminal.get(e.terminal.name);
                if (pending) {
                    const from = pending.returnedExecution;
                    pending.state.execution = e.execution;
                    this.ownExecutions.add(e.execution);
                    this.pendingOwnByTerminal.delete(e.terminal.name);
                    log(
                        `[terminal] rebind start terminal="${e.terminal.name}" ` +
                        `returned!==event=${from !== e.execution}`
                    );
                    pending.resolveBound(e.execution);
                    return;
                }

                if (this.ownExecutions.has(e.execution)) {
                    return;
                }

                const active = this.activeExecutions.get(e.terminal.name);
                if (active?.isOwn) {
                    // In-flight own command: adopt event execution, never overwrite with foreign tracking.
                    active.execution = e.execution;
                    this.ownExecutions.add(e.execution);
                    log(
                        `[terminal] rebind active own terminal="${e.terminal.name}" via onDidStart`
                    );
                    return;
                }

                const commandLine = e.execution.commandLine?.value ?? '<user-typed command>';
                const state = this.registerExecution(e, commandLine, false);
                const buf = this.getBuffer(e.terminal);
                for await (const chunk of e.execution.read()) {
                    buf.append(chunk);
                    state.output += chunk;
                }
            })
        );

        this.disposables.push(
            vscode.window.onDidEndTerminalShellExecution((e) => {
                const state = this.activeExecutions.get(e.terminal.name);
                if (!state || state.execution !== e.execution) {
                    log(
                        `[terminal] onDidEnd ignored terminal="${e.terminal.name}" ` +
                        `exitCode=${e.exitCode} reason=${!state ? 'no-active' : 'execution-mismatch'}`
                    );
                    return;
                }
                const elapsedMs = Date.now() - state.startedAt;
                log(
                    `[terminal] onDidEnd terminal="${e.terminal.name}" exitCode=${e.exitCode} ` +
                    `elapsedMs=${elapsedMs} outputChars=${state.output.length} ` +
                    `own=${state.isOwn}`
                );
                this.activeExecutions.delete(e.terminal.name);
                state.resolveEnd(e.exitCode);
                const finishedAt = Date.now();
                state.finishedAt = finishedAt;
                const undeliveredOutput = state.output.slice(state.deliveredLength);
                this.recentResults.set(e.terminal.name, {
                    undeliveredOutput,
                    exitCode: e.exitCode,
                    finishedAt,
                });
                setTimeout(() => {
                    const current = this.recentResults.get(e.terminal.name);
                    if (current && current.finishedAt === finishedAt) {
                        this.recentResults.delete(e.terminal.name);
                    }
                }, RECENT_RESULT_TTL_MS);
            })
        );

        this.disposables.push(
            vscode.window.onDidCloseTerminal((terminal) => {
                this.outputBuffers.get(terminal.name)?.flush();
                this.outputBuffers.delete(terminal.name);
                this.pendingOwnByTerminal.delete(terminal.name);
                const state = this.activeExecutions.get(terminal.name);
                if (state) {
                    this.activeExecutions.delete(terminal.name);
                    state.resolveEnd(undefined);
                }
                this.recentResults.delete(terminal.name);
                this.managedTerminals.delete(terminal.name);
            })
        );
    }

    /** Whether a terminal with this name is registered (created via terminal_create). */
    hasTerminal(name: string): boolean {
        return this.managedTerminals.has(name);
    }

    listTerminals(): TerminalInfo[] {
        const active = vscode.window.activeTerminal;
        return vscode.window.terminals
            .filter((t) => this.managedTerminals.has(t.name))
            .map((t) => ({
                id: t.name,
                name: t.name,
                isActive: t === active,
                hasShellIntegration: !!t.shellIntegration,
                engine: t.shellIntegration ? 'shell-integration' : 'pty-fallback',
            }));
    }

    getOrCreateTerminal(name?: string): vscode.Terminal {
        if (name) {
            const existing = vscode.window.terminals.find((t) => t.name === name);
            if (existing) return existing;
            const resolved = this.resolveShellProfile(name);
            if (resolved) {
                return vscode.window.createTerminal({ name, shellPath: resolved.shellPath, shellArgs: resolved.shellArgs });
            }
            return vscode.window.createTerminal(name);
        }
        return vscode.window.activeTerminal ?? vscode.window.createTerminal('Terminal');
    }

    private resolveShellProfile(name: string): { shellPath: string; shellArgs?: string[] } | undefined {
        const lower = name.toLowerCase();

        const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
        const profiles = vscode.workspace.getConfiguration('terminal.integrated.profiles').get<Record<string, { path?: string | string[]; args?: string[]; source?: string }>>(platform);
        if (profiles) {
            for (const [profileName, profile] of Object.entries(profiles)) {
                if (profileName.toLowerCase() === lower && profile) {
                    if (profile.path) {
                        const shellPath = Array.isArray(profile.path) ? profile.path[0] : profile.path;
                        return { shellPath, shellArgs: profile.args };
                    }
                }
            }
        }

        const SHELL_MAP: Record<string, { shellPath: string; shellArgs?: string[] }> = {
            'powershell': { shellPath: process.platform === 'win32' ? 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' : 'pwsh' },
            'pwsh': { shellPath: 'pwsh' },
            'cmd': { shellPath: 'C:\\Windows\\System32\\cmd.exe' },
            'command prompt': { shellPath: 'C:\\Windows\\System32\\cmd.exe' },
            'bash': { shellPath: process.platform === 'win32' ? 'C:\\Windows\\System32\\bash.exe' : 'bash' },
            'wsl': { shellPath: process.platform === 'win32' ? 'C:\\Windows\\System32\\wsl.exe' : 'bash' },
            'zsh': { shellPath: 'zsh' },
            'fish': { shellPath: 'fish' },
            'git bash': { shellPath: 'C:\\Program Files\\Git\\bin\\bash.exe' },
        };

        for (const [key, value] of Object.entries(SHELL_MAP)) {
            if (lower.includes(key)) {
                return value;
            }
        }

        return undefined;
    }

    private busyError(terminalName: string, state: ExecutionState): Error {
        const elapsedSec = Math.max(0, Math.round((Date.now() - state.startedAt) / 1000));
        const cleaned = cleanShellOutput(state.output);
        const lines = cleaned ? cleaned.split('\n').filter((l) => l.length > 0) : [];
        const tailCount = 3;
        const tail = lines.slice(-tailCount);
        const tailSection =
            tail.length > 0
                ? `last output:\n  ${tail.join('\n  ')}`
                : 'no output yet';
        return new Error(
            `Terminal '${terminalName}' is busy running: ${state.commandLine} ` +
            `(started ${elapsedSec}s ago, ${tailSection}). ` +
            `Use terminal_wait to continue waiting, terminal_send_text to provide input ` +
            `(send '\\x03' to abort), or target a different terminal.`
        );
    }

    /**
     * On remote SSH, shellIntegration.executeCommand() may return object A while
     * onDidStart/onDidEnd use object B. Wait for the start event and rebind before read().
     */
    private async bindOwnExecution(
        terminal: vscode.Terminal,
        command: string
    ): Promise<{ state: ExecutionState; execution: vscode.TerminalShellExecution; returnedExecution: vscode.TerminalShellExecution }> {
        let resolveEnd!: (exitCode: number | undefined) => void;
        const endPromise = new Promise<number | undefined>((resolve) => { resolveEnd = resolve; });

        // Register active+pending BEFORE executeCommand so onDidStart cannot miss us
        // or overwrite with a foreign tracker.
        const state: ExecutionState = {
            execution: null as unknown as vscode.TerminalShellExecution,
            terminalName: terminal.name,
            commandLine: command,
            startedAt: Date.now(),
            output: '',
            deliveredLength: 0,
            endPromise,
            resolveEnd,
            isOwn: true,
        };
        this.activeExecutions.set(terminal.name, state);

        let resolveBound!: (execution: vscode.TerminalShellExecution) => void;
        const boundPromise = new Promise<vscode.TerminalShellExecution>((resolve) => {
            resolveBound = resolve;
        });
        const pending: PendingOwn = {
            state,
            returnedExecution: null as unknown as vscode.TerminalShellExecution,
            resolveBound,
        };
        this.pendingOwnByTerminal.set(terminal.name, pending);

        const returnedExecution = terminal.shellIntegration!.executeCommand(command);
        pending.returnedExecution = returnedExecution;
        if (!state.execution) {
            state.execution = returnedExecution;
        }
        this.ownExecutions.add(returnedExecution);

        const bindMs = getShellStartBindMs();
        const execution = await Promise.race([
            boundPromise,
            new Promise<vscode.TerminalShellExecution>((resolve) => {
                setTimeout(() => {
                    if (this.pendingOwnByTerminal.get(terminal.name) === pending) {
                        this.pendingOwnByTerminal.delete(terminal.name);
                        log(
                            `[terminal] shell start bind timeout terminal="${terminal.name}" ` +
                            `bindMs=${bindMs} — using returned execution`
                        );
                        resolve(state.execution || returnedExecution);
                    }
                }, bindMs);
            }),
        ]);

        state.execution = execution;
        this.ownExecutions.add(execution);
        if (execution !== returnedExecution) {
            log(`[terminal] bound to start-event execution terminal="${terminal.name}"`);
        }

        return { state, execution, returnedExecution };
    }

    private clearOwnMarkers(
        returnedExecution: vscode.TerminalShellExecution,
        execution: vscode.TerminalShellExecution
    ): void {
        this.ownExecutions.delete(returnedExecution);
        this.ownExecutions.delete(execution);
    }

    async executeCommand(
        command: string,
        terminalName: string | undefined,
        timeoutMs: number,
        onChunk?: (chunk: string) => void
    ): Promise<CommandResult> {
        const terminal = this.getOrCreateTerminal(terminalName);

        const existing = this.activeExecutions.get(terminal.name);
        if (existing) {
            log(
                `[terminal] executeCommand busy terminal="${terminal.name}" ` +
                `running="${existing.commandLine.slice(0, 80)}" elapsedMs=${Date.now() - existing.startedAt}`
            );
            throw this.busyError(terminal.name, existing);
        }
        if (this.pendingOwnByTerminal.has(terminal.name)) {
            throw new Error(
                `Terminal '${terminal.name}' is busy starting a command. ` +
                `Use terminal_wait or target a different terminal.`
            );
        }

        terminal.show(true);

        if (!terminal.shellIntegration) {
            log(`[terminal] executeCommand waiting for shellIntegration terminal="${terminal.name}"`);
            await this.waitForShellIntegration(terminal, 8000);
        }

        if (!terminal.shellIntegration) {
            log(`[terminal] executeCommand no shellIntegration — sendText fallback terminal="${terminal.name}"`);
            terminal.sendText(command);
            return {
                output:
                    '[Shell integration unavailable — command sent via sendText. terminal_wait ' +
                    'and exit codes won\'t work for this terminal.\n' +
                    'Enable: terminal.integrated.shellIntegration.enabled = true]',
                exitCode: undefined,
                timedOut: false,
            };
        }

        log(
            `[terminal] executeCommand start terminal="${terminal.name}" timeoutMs=${timeoutMs} ` +
            `command="${command.slice(0, 120)}${command.length > 120 ? '…' : ''}"`
        );

        const { state, execution, returnedExecution } = await this.bindOwnExecution(terminal, command);
        const buf = this.getBuffer(terminal);

        const readPromise = (async () => {
            for await (const chunk of execution.read()) {
                state.output += chunk;
                buf.append(chunk);
                if (onChunk) onChunk(chunk);
            }
            log(
                `[terminal] execution.read() closed terminal="${terminal.name}" ` +
                `outputChars=${state.output.length} elapsedMs=${Date.now() - state.startedAt}`
            );
        })();
        readPromise.catch((err) => {
            log(`[terminal] execution.read() error terminal="${terminal.name}": ${err}`);
        });

        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<'timeout'>((resolve) => {
            timeoutHandle = setTimeout(() => resolve('timeout'), timeoutMs);
        });

        const outcome = await Promise.race([
            readPromise.then(() => 'read_done' as const),
            state.endPromise.then(() => 'shell_end' as const),
            timeoutPromise,
        ]);

        if (timeoutHandle) clearTimeout(timeoutHandle);
        this.clearOwnMarkers(returnedExecution, execution);

        if (outcome === 'timeout') {
            log(
                `[terminal] executeCommand timeout terminal="${terminal.name}" ` +
                `timeoutMs=${timeoutMs} outputChars=${state.output.length}`
            );
            const slice = state.output.slice(state.deliveredLength);
            state.deliveredLength = state.output.length;
            const cleaned = cleanShellOutput(slice);
            const body = cleaned || '(no output yet)';
            return {
                output:
                    `${body}\n\n[STILL RUNNING — ${Math.round(timeoutMs / 1000)}s elapsed, no exit yet. ` +
                    `Call terminal_wait (terminal_name='${terminal.name}') to continue waiting, ` +
                    `or send '\\x03' via terminal_send_text to abort.]`,
                exitCode: undefined,
                timedOut: true,
            };
        }

        if (outcome === 'shell_end') {
            const drainMs = getShellReadDrainMs();
            log(
                `[terminal] executeCommand shell_end before read() closed terminal="${terminal.name}" ` +
                `drainMs=${drainMs} outputChars=${state.output.length}`
            );
            if (drainMs > 0) {
                await Promise.race([
                    readPromise,
                    new Promise<void>((resolve) => setTimeout(resolve, drainMs)),
                ]);
            }
        }

        const exitCode = await Promise.race([
            state.endPromise,
            new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), END_EVENT_WAIT_MS)),
        ]);
        const slice = state.output.slice(state.deliveredLength);
        state.deliveredLength = state.output.length;
        const recent = this.recentResults.get(terminal.name);
        if (recent && state.finishedAt !== undefined && recent.finishedAt === state.finishedAt) {
            this.recentResults.set(terminal.name, {
                undeliveredOutput: '',
                exitCode: recent.exitCode,
                finishedAt: recent.finishedAt,
            });
        }
        log(
            `[terminal] executeCommand done terminal="${terminal.name}" via=${outcome} ` +
            `exitCode=${exitCode} outputChars=${slice.length} elapsedMs=${Date.now() - state.startedAt}`
        );
        return {
            output: cleanShellOutput(slice) || '(no output)',
            exitCode,
            timedOut: false,
        };
    }

    async startBackgroundExecution(
        command: string,
        terminalName?: string
    ): Promise<{ terminalName: string; message: string }> {
        const terminal = this.getOrCreateTerminal(terminalName);

        const existing = this.activeExecutions.get(terminal.name);
        if (existing) {
            throw this.busyError(terminal.name, existing);
        }
        if (this.pendingOwnByTerminal.has(terminal.name)) {
            throw new Error(
                `Terminal '${terminal.name}' is busy starting a command. ` +
                `Use terminal_wait or target a different terminal.`
            );
        }

        terminal.show(true);

        if (!terminal.shellIntegration) {
            await this.waitForShellIntegration(terminal, 8000);
        }

        if (!terminal.shellIntegration) {
            terminal.sendText(command);
            return {
                terminalName: terminal.name,
                message:
                    `[Shell integration unavailable — command sent via sendText to '${terminal.name}'. ` +
                    `terminal_wait and exit codes won't work for this terminal.\n` +
                    `Enable: terminal.integrated.shellIntegration.enabled = true]`,
            };
        }

        const { state, execution, returnedExecution } = await this.bindOwnExecution(terminal, command);
        const buf = this.getBuffer(terminal);

        (async () => {
            try {
                for await (const chunk of execution.read()) {
                    state.output += chunk;
                    buf.append(chunk);
                }
            } finally {
                this.clearOwnMarkers(returnedExecution, execution);
            }
        })().catch(() => { });

        return {
            terminalName: terminal.name,
            message:
                `Command started in terminal '${terminal.name}': ${command}\n` +
                `Use terminal_wait (terminal_name='${terminal.name}') to retrieve output and exit code.`,
        };
    }

    async waitForExecution(
        terminalName: string,
        timeoutMs: number
    ): Promise<CommandResult & { fromCache?: boolean; cacheAgeMs?: number }> {
        const state = this.activeExecutions.get(terminalName);
        if (state) {
            let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
            const timeoutPromise = new Promise<'timeout'>((resolve) => {
                timeoutHandle = setTimeout(() => resolve('timeout'), timeoutMs);
            });
            const endPromise = state.endPromise.then((exitCode) => ({ kind: 'done' as const, exitCode }));
            const outcome = await Promise.race([endPromise, timeoutPromise]);
            if (timeoutHandle) clearTimeout(timeoutHandle);

            const slice = state.output.slice(state.deliveredLength);
            state.deliveredLength = state.output.length;

            if (outcome === 'timeout') {
                const body = cleanShellOutput(slice) || '(no new output)';
                return {
                    output:
                        `${body}\n\n[STILL RUNNING — ${Math.round(timeoutMs / 1000)}s waited, no exit yet. ` +
                        `Call terminal_wait again or send '\\x03' via terminal_send_text to abort.]`,
                    exitCode: undefined,
                    timedOut: true,
                };
            }

            const recent = this.recentResults.get(terminalName);
            if (recent && state.finishedAt !== undefined && recent.finishedAt === state.finishedAt) {
                this.recentResults.set(terminalName, {
                    undeliveredOutput: '',
                    exitCode: recent.exitCode,
                    finishedAt: recent.finishedAt,
                });
            }

            return {
                output: cleanShellOutput(slice) || '(no output)',
                exitCode: outcome.exitCode,
                timedOut: false,
            };
        }

        const cached = this.recentResults.get(terminalName);
        if (cached && Date.now() - cached.finishedAt < RECENT_RESULT_TTL_MS) {
            this.recentResults.delete(terminalName);
            const ageMs = Date.now() - cached.finishedAt;
            const body = cleanShellOutput(cached.undeliveredOutput) || '(no output)';
            return {
                output: `${body}\n\n[completed ${Math.round(ageMs / 1000)}s ago]`,
                exitCode: cached.exitCode,
                timedOut: false,
                fromCache: true,
                cacheAgeMs: ageMs,
            };
        }

        throw new Error(
            `Terminal '${terminalName}' has no active or recent execution. ` +
            `Start one with terminal_run, or check terminal_list.`
        );
    }

    async createTerminal(name: string, cwd?: string, shell?: string): Promise<{ terminalName: string; engine: 'shell-integration' | 'pty-fallback' }> {
        const resolved = shell ? { shellPath: shell } : this.resolveShellProfile(name);
        const options: vscode.TerminalOptions = {
            name,
            cwd: cwd ? vscode.Uri.file(cwd) : undefined,
            ...(resolved ? { shellPath: resolved.shellPath, shellArgs: resolved.shellArgs } : {}),
        };
        const terminal = vscode.window.createTerminal(options);
        terminal.show(true);
        // On remote SSH the shell-integration execution read stream can be
        // silent for the very first command on a freshly created terminal.
        // Run a no-op warmup to force the read stream to wire up before we
        // return control to the caller.
        if (terminal.shellIntegration) {
            const warmupMs = getTerminalCreateWarmupMs();
            if (warmupMs > 0) {
                try {
                    const warmup = terminal.shellIntegration.executeCommand('true');
                    await Promise.race([
                        (async () => {
                            for await (const _ of warmup.read()) { /* drain */ }
                            return 'done' as const;
                        })(),
                        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), warmupMs)),
                    ]);
                } catch {
                    // warmup is best-effort; ignore and continue
                }
            }
        }
        if (!terminal.shellIntegration) {
            await this.waitForShellIntegration(terminal, 8000);
        }
        this.managedTerminals.set(terminal.name, terminal.name);
        return { terminalName: terminal.name, engine: terminal.shellIntegration ? 'shell-integration' : 'pty-fallback' };
    }

    sendText(text: string, terminalName?: string, addNewline = true): string {
        const terminal = this.getOrCreateTerminal(terminalName);
        terminal.show(true);
        terminal.sendText(text, addNewline);
        return terminal.name;
    }

    readOutput(terminalName?: string, lines?: number): string {
        let terminal: vscode.Terminal | undefined;

        if (terminalName) {
            terminal = vscode.window.terminals.find((t) => t.name === terminalName);
            if (!terminal) {
                const names = vscode.window.terminals.map((t) => `"${t.name}"`).join(', ');
                throw new Error(`Terminal "${terminalName}" not found. Open: ${names || 'none'}`);
            }
        } else {
            terminal =
                vscode.window.activeTerminal ??
                vscode.window.terminals[vscode.window.terminals.length - 1];
            if (!terminal) throw new Error('No terminals open');
        }

        const buf = this.outputBuffers.get(terminal.name);
        if (!buf || buf.lineCount === 0) {
            return (
                '[No buffered output yet. Output is captured via shell integration — run a\n' +
                'command in the terminal (or use terminal_run) to populate the buffer.\n' +
                'If shell integration is disabled, enable it in VS Code settings:\n' +
                'terminal.integrated.shellIntegration.enabled = true]'
            );
        }

        return buf.getLines(lines).join('\n');
    }

    clearBuffer(terminalName?: string): void {
        if (terminalName) {
            this.outputBuffers.get(terminalName)?.clear();
        } else {
            const t = vscode.window.activeTerminal;
            if (t) this.outputBuffers.get(t.name)?.clear();
        }
    }

    private waitForShellIntegration(terminal: vscode.Terminal, timeoutMs: number): Promise<void> {
        return new Promise((resolve) => {
            if (terminal.shellIntegration) { resolve(); return; }
            const timer = setTimeout(resolve, timeoutMs);
            const sub = vscode.window.onDidChangeTerminalShellIntegration((e) => {
                if (e.terminal === terminal) {
                    clearTimeout(timer);
                    sub.dispose();
                    resolve();
                }
            });
        });
    }

    dispose(): void {
        this.disposables.forEach((d) => d.dispose());
        this.outputBuffers.clear();
        this.pendingOwnByTerminal.clear();
    }
}

export function cleanShellOutput(raw: string): string {
    return raw
        .replace(/\x1b\[[0-9;]*[mGKHFABCDEJsupr]/g, '')
        .replace(/\x1b\][^\x07]*\x07/g, '')
        .replace(/\x1b[()][AB012]/g, '')
        .replace(/\r/g, '')
        .trim();
}
