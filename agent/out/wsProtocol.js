"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RequestCorrelator = void 0;
exports.parseWsMessage = parseWsMessage;
exports.sendMessage = sendMessage;
exports.replaceSocket = replaceSocket;
exports.newRequestId = newRequestId;
exports.logProtocol = logProtocol;
const ws_1 = __importDefault(require("ws"));
const logger_1 = require("./logger");
/**
 * Shared WebSocket protocol helpers used by both the hub and satellite sides
 * of the vscode-mcp extension. These eliminate duplicated message parsing,
 * socket replacement, and request/response correlation logic.
 */
/** Parse a raw WebSocket message into a JSON object. Returns null on parse failure. */
function parseWsMessage(data) {
    try {
        return JSON.parse(data.toString());
    }
    catch {
        return null;
    }
}
/** Send a JSON message on a socket if it is open. Returns false if not sent. */
function sendMessage(ws, msg) {
    if (!ws || ws.readyState !== ws_1.default.OPEN)
        return false;
    try {
        ws.send(JSON.stringify(msg));
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Detach and close an existing socket without firing its 'close' listeners.
 * Used when replacing a connection (e.g. re-registering a satellite, or
 * switching from satellite to hub) so stale handlers don't trigger reconnect.
 */
function replaceSocket(ws) {
    if (!ws)
        return;
    ws.removeAllListeners('close');
    try {
        ws.close();
    }
    catch {
        /* noop */
    }
}
/**
 * Correlates request/response messages by requestId over a WebSocket.
 * Used by the hub to track in-flight tool calls routed to satellites.
 */
class RequestCorrelator {
    constructor() {
        this.pending = new Map();
    }
    /**
     * Register a pending request. Returns a promise that resolves when
     * `resolve` is called with the matching requestId, or rejects on timeout.
     */
    register(requestId, timeoutMs, onTimeout) {
        return new Promise((resolve, reject) => {
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
    resolve(requestId, value) {
        const pending = this.pending.get(requestId);
        if (!pending)
            return false;
        this.pending.delete(requestId);
        clearTimeout(pending.timeout);
        pending.resolve(value);
        return true;
    }
    /** Reject a pending request by requestId. Returns true if found, false otherwise. */
    reject(requestId, reason) {
        const pending = this.pending.get(requestId);
        if (!pending)
            return false;
        this.pending.delete(requestId);
        clearTimeout(pending.timeout);
        pending.reject(reason);
        return true;
    }
    /** Reject and clear all pending requests (e.g. on socket close). */
    rejectAll(reason) {
        for (const [requestId, pending] of this.pending.entries()) {
            clearTimeout(pending.timeout);
            pending.reject(reason);
        }
        this.pending.clear();
    }
    get size() {
        return this.pending.size;
    }
}
exports.RequestCorrelator = RequestCorrelator;
/** Generate a unique requestId for correlation. */
function newRequestId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
/** Log a message with a given prefix (kept for parity with existing log calls). */
function logProtocol(prefix, message) {
    (0, logger_1.log)(`[${prefix}] ${message}`);
}
//# sourceMappingURL=wsProtocol.js.map