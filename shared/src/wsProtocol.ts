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
    private pending = new Map<string, { resolve: (v: T) => void; reject: (r?: unknown) => void; timeout: NodeJS.Timeout }>();
    register(requestId: string, timeoutMs: number, onTimeout?: (id: string) => void): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const timeout = setTimeout(() => { this.pending.delete(requestId); onTimeout?.(requestId); reject(new Error(`Request timed out after ${timeoutMs}ms`)); }, timeoutMs);
            this.pending.set(requestId, { resolve, reject, timeout });
        });
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
