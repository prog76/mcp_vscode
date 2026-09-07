/** Shared types for the standalone agent (mirrors the extension's shapes). */
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
    stderr?: string;
    timeoutMs?: number;
    truncated?: boolean;
    maxOutputBytes?: number;
}
