import WebSocket from 'ws';
import { trace } from './tracer';

export function parseWsMessage(data: WebSocket.RawData): any | null {
    try { return JSON.parse(data.toString()); } catch { return null; }
}

export function sendMessage(ws: WebSocket | null, msg: unknown): boolean {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try { ws.send(JSON.stringify(msg)); return true; } catch { return false; }
}

export function replaceSocket(ws: WebSocket | null): void {
    if (!ws) return;
    ws.removeAllListeners('close');
    try { ws.close(); } catch { /* noop */ }
}

export class RequestCorrelator<T> {
    private pending = new Map<string, { resolve: (v: T) => void; reject: (r?: unknown) => void; timeout: NodeJS.Timeout; onTimeout?: (id: string) => void }>();
    register(requestId: string, timeoutMs: number, onTimeout?: (id: string) => void): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const timeout = setTimeout(() => { this.pending.delete(requestId); onTimeout?.(requestId); reject(new Error(`Request timed out after ${timeoutMs}ms`)); }, timeoutMs);
            this.pending.set(requestId, { resolve, reject, timeout, onTimeout });
        });
    }
    /** Reset the deadline for a pending request. Returns true if the request was found and rearmed. */
    rearm(requestId: string, newTimeoutMs: number): boolean {
        const pending = this.pending.get(requestId);
        if (!pending) return false;
        clearTimeout(pending.timeout);
        pending.timeout = setTimeout(() => { this.pending.delete(requestId); pending.onTimeout?.(requestId); pending.reject(new Error(`Request timed out after ${newTimeoutMs}ms`)); }, newTimeoutMs);
        return true;
    }
    resolve(requestId: string, value: T): boolean {
        const pending = this.pending.get(requestId);
        if (!pending) return false;
        this.pending.delete(requestId); clearTimeout(pending.timeout); pending.resolve(value); return true;
    }
    reject(requestId: string, reason?: unknown): boolean {
        const pending = this.pending.get(requestId);
        if (!pending) return false;
        this.pending.delete(requestId); clearTimeout(pending.timeout); pending.reject(reason); return true;
    }
    rejectAll(reason?: unknown): void {
        for (const [id, p] of this.pending.entries()) { clearTimeout(p.timeout); p.reject(reason); }
        this.pending.clear();
    }
    get size(): number { return this.pending.size; }
}

export function newRequestId(): string { return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }

export function logProtocol(prefix: string, message: string): void {
    trace(`[${prefix}] ${message}`);
}

/**
 * Progress notification sent from satellite to hub during a long-running tool
 * call. The hub forwards these as MCP `notifications/progress` and uses them
 * to optionally rearm the per-request deadline.
 */
export interface ProgressMessage {
    type: 'progress';
    requestId: string;
    /** Total bytes of output captured so far for this request */
    bytes: number;
    /** Wall-clock timestamp (ms) when this progress was reported */
    timestamp: number;
}

export function newProgressMessage(requestId: string, bytes: number): ProgressMessage {
    return { type: 'progress', requestId, bytes, timestamp: Date.now() };
}
