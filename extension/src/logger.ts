import * as vscode from 'vscode';

let outputChannel: vscode.OutputChannel | null = null;

export function initLogger(channel: vscode.OutputChannel): void {
    outputChannel = channel;
}

export function log(message: string): void {
    const ts = new Date().toISOString();
    const line = `[${ts}] ${message}`;
    outputChannel?.appendLine(line);
    console.log(`[VS Code MCP] ${message}`);
}