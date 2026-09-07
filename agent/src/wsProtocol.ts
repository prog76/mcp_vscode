import WebSocket from 'ws';
import { log } from './logger';

/**
 * Shared WebSocket protocol helpers used by both the hub and satellite sides
 * of the vscode-mcp extension. These eliminate duplicated message parsing,
 * socket replacement, and request/response correlation logic.
 */

/** Parse a raw WebSocket message into a JSON object. Returns null on parse failure. */
export function parseWsMessage(data: WebSocket.RawData): any | null {
    try {
        return JSON.parse(data.toString());
    } catch {
        return null;
    }
}

/** Send a JSON message on a socket if it is open. Returns false if not sent. */
export function sendMessage(ws: WebSocket | null, msg: unknown): boolean {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
        ws.send(JSON.stringify(msg));
        return true;
    } catch {
        return false;
    }
}

/**
 * Detach and close an existing socket without firing its 'close' listeners.
 * Used when replacing a connection (e.g. re-registering a satellite, or
 * switching from satellite to hub) so stale handlers don't trigger reconnect.
 */
export function replaceSocket(ws: WebSocket | null): void {
    if (!ws) return;
    ws.removeAllListeners('close');
    try {
        ws.close();
    } catch {
        /* noop */
    }
}

/**
 * Correlates request/response messages by requestId over a WebSocket.
 * Used by the hub to track in-flight tool calls routed to satellites.
 */
export class RequestCorrelator<T> {
    private pending = new Map<string, { resolve: (value: T) => void; reject: (reason?: unknown) => void; timeout: NodeJS.Timeout }>();

    /**
     * Register a pending request. Returns a promise that resolves when
     * `resolve` is called with the matching requestId, or rejects on timeout.
     */
    register(requestId: string, timeoutMs: number, onTimeout?: (requestId: string) => void): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pending.delete(requestId);
                onTimeout?.(requestId);
                reject(new Error(`Request timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            this.pending.set(requestId, { resolve, reject, timeout });
        });
    }

    /**
     * Resolve a pending request by requestId. Returns true if a request was
     * found and resolved, false otherwise.
     */
    resolve(requestId: string, value: T): boolean {
        const pending = this.pending.get(requestId);
        if (!pending) return false;
        this.pending.delete(requestId);
        clearTimeout(pending.timeout);
        pending.resolve(value);
        return true;
    }

    /** Reject a pending request by requestId. Returns true if found, false otherwise. */
    reject(requestId: string, reason?: unknown): boolean {
        const pending = this.pending.get(requestId);
        if (!pending) return false;
        this.pending.delete(requestId);
        clearTimeout(pending.timeout);
        pending.reject(reason);
        return true;
    }

    /** Reject and clear all pending requests (e.g. on socket close). */
    rejectAll(reason?: unknown): void {
        for (const [requestId, pending] of this.pending.entries()) {
            clearTimeout(pending.timeout);
            pending.reject(reason);
        }
        this.pending.clear();
    }

    get size(): number {
        return this.pending.size;
    }
}

/** Generate a unique requestId for correlation. */
export function newRequestId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Log a message with a given prefix (kept for parity with existing log calls). */
export function logProtocol(prefix: string, message: string): void {
    log(`[${prefix}] ${message}`);
}