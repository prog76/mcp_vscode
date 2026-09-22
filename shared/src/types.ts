export interface ToolResult {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
}
export interface TerminalInfo {
    id: string; name: string; isActive: boolean;
    hasShellIntegration: boolean; engine: 'shell-integration' | 'pty-fallback';
}
export interface WriteReport {
    path: string; bytes: number; lines: number; tail: string;
}
export interface CommandResult {
    output: string; exitCode: number | undefined; timedOut: boolean;
    stderr?: string; timeoutMs?: number; truncated?: boolean; maxOutputBytes?: number;
    outputLines?: number; truncatedLines?: number;
    written?: WriteReport[];
}
export class BinaryNotAllowedError extends Error {
    constructor(binary: string, hint: string) {
        super(`Binary '${binary}' is not on the execute allowlist. ${hint}`);
        this.name = "BinaryNotAllowedError";
    }
}
export interface Tool {
    name: string; description: string; inputSchema: Record<string, unknown>;
}
export interface Agent {
    callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
}

