"use strict";
/**
 * Shared JSON-RPC 2.0 response helpers for the MCP HTTP endpoint.
 * Eliminates the repeated inline construction of jsonrpc result/error objects
 * in hubServer.ts.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.JsonRpcErrorCode = void 0;
exports.jsonrpcResult = jsonrpcResult;
exports.jsonrpcError = jsonrpcError;
/** Build a successful JSON-RPC response. */
function jsonrpcResult(id, result) {
    return { jsonrpc: '2.0', id, result };
}
/** Build an error JSON-RPC response. */
function jsonrpcError(id, code, message) {
    return { jsonrpc: '2.0', id, error: { code, message } };
}
/** Standard JSON-RPC error codes. */
exports.JsonRpcErrorCode = {
    ParseError: -32700,
    InvalidRequest: -32600,
    MethodNotFound: -32601,
    InvalidParams: -32602,
    InternalError: -32603,
};
//# sourceMappingURL=mcpResponse.js.map