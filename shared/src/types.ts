export interface ToolResult {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
}
export interface TerminalInfo {
    id: string; name: string; isActive: boolean;
    hasShellIntegration: boolean; engine: 'shell-integration' | 'pty-fallback';
}
export interface CommandResult {
    output: string; exitCode: number | undefined; timedOut: boolean;
    stderr?: string; timeoutMs?: number; truncated?: boolean; maxOutputBytes?: number;
}
export interface Tool {
    name: string; description: string; inputSchema: Record<string, unknown>;
}
export interface Agent {
    callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
}

