/**
 * Shared trace sink used by vscode-free shared modules (wsProtocol, ...).
 *
 * Hosts inject their full-power logger at startup:
 *  - extension: setTracer((m) => log(m))  -> VS Code OutputChannel (full power)
 *  - agent:     setTracer((m) => log(m))  -> stdout + optional file (full power)
 *
 * Default console.log makes uninitialized use visible but hosts normally
 * inject before any protocol traffic.
 */
export type Tracer = (message: string) => void;

let tracer: Tracer = (message) => console.log(`[vscode-mcp] ${message}`);

export function setTracer(t: Tracer): void {
    tracer = t;
}

export function trace(message: string): void {
    tracer(message);
}
