/**
 * Shared JSON-RPC 2.0 response helpers for the MCP HTTP endpoint.
 * Eliminates the repeated inline construction of jsonrpc result/error objects
 * in hubServer.ts.
 */

export interface JsonRpcResponse {
    jsonrpc: '2.0';
    id: unknown;
    result?: unknown;
    error?: { code: number; message: string };
}

/** Build a successful JSON-RPC response. */
export function jsonrpcResult(id: unknown, result: unknown): JsonRpcResponse {
    return { jsonrpc: '2.0', id, result };
}

/** Build an error JSON-RPC response. */
export function jsonrpcError(id: unknown, code: number, message: string): JsonRpcResponse {
    return { jsonrpc: '2.0', id, error: { code, message } };
}

/** Standard JSON-RPC error codes. */
export const JsonRpcErrorCode = {
    ParseError: -32700,
    InvalidRequest: -32600,
    MethodNotFound: -32601,
    InvalidParams: -32602,
    InternalError: -32603,
} as const;