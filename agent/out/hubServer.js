"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.HubServer = void 0;
const http = __importStar(require("http"));
const ws_1 = __importDefault(require("ws"));
const toolsSchema_1 = require("./toolsSchema");
const config_1 = require("./config");
const logger_1 = require("./logger");
const wsProtocol_1 = require("./wsProtocol");
const mcpResponse_1 = require("./mcpResponse");
class HubServer {
    constructor(ownAgent, ownSessionId, extensionVersion, port, host = config_1.CONFIG_DEFAULTS.host, satelliteTimeoutMs = config_1.CONFIG_DEFAULTS.satelliteTimeoutMs) {
        this.server = null;
        this.wss = null;
        this.satellites = new Map();
        this.heartbeatTimer = null;
        this.eventListeners = [];
        this.pendingRequests = new wsProtocol_1.RequestCorrelator();
        this.ownAgent = ownAgent;
        this.ownSessionId = ownSessionId;
        this.extensionVersion = extensionVersion;
        this._port = port;
        this.host = host;
        this.satelliteTimeoutMs = satelliteTimeoutMs;
    }
    get port() {
        return this._port;
    }
    get satelliteCount() {
        return this.satellites.size;
    }
    get satelliteIds() {
        return Array.from(this.satellites.keys());
    }
    onEvent(listener) {
        this.eventListeners.push(listener);
    }
    emitEvent(event) {
        for (const listener of this.eventListeners) {
            try {
                listener(event);
            }
            catch { /* noop */ }
        }
    }
    async start() {
        this.server = http.createServer((req, res) => {
            this.handleHttpRequest(req, res);
        });
        await new Promise((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen(this._port, this.host, () => {
                this.server.removeListener('error', reject);
                resolve();
            });
        });
        this.wss = new ws_1.default.Server({ server: this.server, path: '/ws' });
        this.wss.on('connection', (ws) => {
            this.handleNewConnection(ws);
        });
        // Broadcast heartbeat to satellites every 10s; drop stale ones
        this.heartbeatTimer = setInterval(() => {
            const now = Date.now();
            for (const [sessionId, info] of this.satellites.entries()) {
                if (now - info.lastSeen > 30000) {
                    this.satellites.delete(sessionId);
                    try {
                        info.ws.close();
                    }
                    catch { /* noop */ }
                }
            }
            for (const info of this.satellites.values()) {
                try {
                    info.ws.send(JSON.stringify({ type: 'ping' }));
                }
                catch { /* noop */ }
            }
        }, 10000);
    }
    async stop() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        for (const info of this.satellites.values()) {
            try {
                info.ws.close();
            }
            catch { /* noop */ }
        }
        this.satellites.clear();
        if (this.wss) {
            this.wss.close();
            this.wss = null;
        }
        if (this.server) {
            await new Promise((resolve) => this.server.close(() => resolve()));
            this.server = null;
        }
    }
    handleNewConnection(ws) {
        let registered = false;
        const timeout = setTimeout(() => {
            if (!registered) {
                ws.close(4001, 'Register timeout');
            }
        }, 5000);
        ws.on('message', (data) => {
            const msg = (0, wsProtocol_1.parseWsMessage)(data);
            if (!msg)
                return;
            switch (msg.type) {
                case 'register':
                    if (msg.sessionId) {
                        registered = true;
                        clearTimeout(timeout);
                        const existing = this.satellites.get(msg.sessionId);
                        if (existing && existing.ws !== ws) {
                            (0, logger_1.log)(`[hub] Replacing existing satellite connection for "${msg.sessionId}"`);
                            (0, wsProtocol_1.replaceSocket)(existing.ws);
                        }
                        (0, logger_1.log)(`[hub] Satellite registered: "${msg.sessionId}"`);
                        this.satellites.set(msg.sessionId, { sessionId: msg.sessionId, ws, lastSeen: Date.now() });
                        (0, wsProtocol_1.sendMessage)(ws, { type: 'registered', sessionId: msg.sessionId });
                        this.emitEvent({
                            type: 'satellite-connected',
                            sessionId: msg.sessionId,
                            satelliteCount: this.satellites.size,
                        });
                    }
                    break;
                case 'pong':
                    for (const info of this.satellites.values()) {
                        if (info.ws === ws) {
                            info.lastSeen = Date.now();
                            break;
                        }
                    }
                    break;
                case 'result':
                    this.handleSatelliteResult(msg);
                    break;
                case 'error':
                    this.handleSatelliteResult(msg);
                    break;
            }
        });
        ws.on('close', () => {
            for (const [sessionId, info] of this.satellites.entries()) {
                if (info.ws === ws) {
                    this.satellites.delete(sessionId);
                    (0, logger_1.log)(`[hub] Satellite disconnected: "${sessionId}"`);
                    this.emitEvent({
                        type: 'satellite-disconnected',
                        sessionId,
                        satelliteCount: this.satellites.size,
                    });
                    break;
                }
            }
        });
    }
    handleSatelliteResult(msg) {
        (0, logger_1.log)(`[hub] Satellite ${msg.type} for requestId=${msg.requestId}`);
        if (msg.type === 'error') {
            this.pendingRequests.reject(msg.requestId, new Error(msg.message || 'Satellite error'));
        }
        else {
            this.pendingRequests.resolve(msg.requestId, msg.result);
        }
    }
    handleHttpRequest(req, res) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }
        const url = req.url || '/';
        if (req.method === 'GET' && (url === '/health' || url === '/api/health')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'ok',
                sessionId: this.ownSessionId,
                version: this.extensionVersion,
                satellites: Array.from(this.satellites.keys()),
            }));
            return;
        }
        if (req.method === 'GET' && url === '/sessions') {
            // Do not expose which window is the hub — sessions are equal peers
            // and the role swaps on hub death. Return only the session IDs.
            const sessions = [
                { sessionId: this.ownSessionId },
                ...Array.from(this.satellites.values()).map((s) => ({ sessionId: s.sessionId })),
            ];
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(sessions));
            return;
        }
        if (url === '/mcp' && req.method === 'POST') {
            let body = '';
            req.on('data', (chunk) => { body += chunk; });
            req.on('end', async () => {
                try {
                    const json = JSON.parse(body);
                    const response = await this.handleMcpRequest(json);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(response));
                }
                catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify((0, mcpResponse_1.jsonrpcError)(null, mcpResponse_1.JsonRpcErrorCode.ParseError, String(e))));
                }
            });
            return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
    }
    async handleMcpRequest(msg) {
        if (msg.method === 'initialize') {
            return (0, mcpResponse_1.jsonrpcResult)(msg.id, {
                protocolVersion: '2025-03-26',
                capabilities: { tools: {} },
                serverInfo: { name: 'vscode-mcp-hub', version: this.extensionVersion },
            });
        }
        if (msg.method === 'notifications/initialized') {
            return (0, mcpResponse_1.jsonrpcResult)(msg.id, {});
        }
        if (msg.method === 'tools/list') {
            return (0, mcpResponse_1.jsonrpcResult)(msg.id, { tools: toolsSchema_1.TOOLS });
        }
        if (msg.method === 'tools/call') {
            const tool = msg.params?.name;
            const args = msg.params?.arguments || {};
            if (tool === 'terminal_list_sessions') {
                // Sessions are equal peers — hub vs satellite is an internal
                // routing detail (roles swap on hub death), so don't leak which
                // window is currently acting as hub. List only the session IDs.
                const sessions = [
                    this.ownSessionId,
                    ...Array.from(this.satellites.keys()),
                ];
                return (0, mcpResponse_1.jsonrpcResult)(msg.id, {
                    content: [{ type: 'text', text: sessions.length ? sessions.join('\n') : 'No sessions.' }],
                });
            }
            const targetSession = args.session_id;
            // SECURITY: session_id is required so the agent cannot discover or
            // guess workspaces — it must be told which one to target.
            if (!targetSession) {
                return (0, mcpResponse_1.jsonrpcError)(msg.id, mcpResponse_1.JsonRpcErrorCode.InvalidParams, 'session_id is required. The agent must be told which workspace to target — it cannot discover or guess workspaces.');
            }
            // The hub's own session is an equal peer of every satellite: "hub"
            // is only an artifact of which window bound the WebSocket listener
            // first, and a satellite automatically takes over when the hub
            // dies. So when the target is our own session, run the tool
            // locally on this window's ServerlessServer — identical to how a
            // satellite executes it on receipt of an `execute` message.
            // Only sessions that are registered *nowhere* are "empty" and
            // rejected below.
            if (targetSession === this.ownSessionId) {
                (0, logger_1.log)(`[hub] Routing tool="${tool}" to own session "${targetSession}"`);
                try {
                    const result = await this.ownAgent.callTool(tool, args);
                    return (0, mcpResponse_1.jsonrpcResult)(msg.id, result);
                }
                catch (e) {
                    return (0, mcpResponse_1.jsonrpcError)(msg.id, mcpResponse_1.JsonRpcErrorCode.InternalError, String(e));
                }
            }
            const satellite = this.satellites.get(targetSession);
            if (!satellite) {
                (0, logger_1.log)(`[hub] Cannot route tool="${tool}": no session "${targetSession}"`);
                return (0, mcpResponse_1.jsonrpcError)(msg.id, mcpResponse_1.JsonRpcErrorCode.InvalidParams, `No session registered with id: ${targetSession}`);
            }
            const requestId = (0, wsProtocol_1.newRequestId)();
            (0, logger_1.log)(`[hub] Routing tool="${tool}" to satellite "${targetSession}" (requestId=${requestId})`);
            try {
                const result = await this.executeOnSatellite(satellite.ws, requestId, tool, args);
                return (0, mcpResponse_1.jsonrpcResult)(msg.id, result);
            }
            catch (e) {
                return (0, mcpResponse_1.jsonrpcError)(msg.id, mcpResponse_1.JsonRpcErrorCode.InternalError, String(e));
            }
        }
        return (0, mcpResponse_1.jsonrpcError)(msg.id ?? null, mcpResponse_1.JsonRpcErrorCode.MethodNotFound, `Method not found: ${msg.method}`);
    }
    resolveSatelliteWaitMs(tool, args) {
        const base = this.satelliteTimeoutMs;
        if (tool === 'terminal_run' || tool === 'terminal_wait') {
            const fromArgs = typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined;
            const toolDefault = tool === 'terminal_wait'
                ? config_1.CONFIG_DEFAULTS.terminalWaitTimeoutMs
                : config_1.CONFIG_DEFAULTS.terminalRunTimeoutMs;
            return Math.max(base, fromArgs ?? toolDefault);
        }
        return base;
    }
    executeOnSatellite(ws, requestId, tool, args) {
        const timeoutMs = this.resolveSatelliteWaitMs(tool, args || {});
        const promise = this.pendingRequests.register(requestId, timeoutMs, (id) => {
            (0, logger_1.log)(`[hub] Satellite timed out for requestId=${id} tool="${tool}" after ${timeoutMs}ms`);
        });
        const sent = (0, wsProtocol_1.sendMessage)(ws, {
            type: 'execute',
            requestId,
            tool,
            params: args,
        });
        if (!sent) {
            const err = new Error(`Failed to send execute to satellite — tool="${tool}" requestId=${requestId}`);
            this.pendingRequests.reject(requestId, err);
            (0, logger_1.log)(`[hub] Failed to send execute to satellite — tool="${tool}" requestId=${requestId}`);
            return promise;
        }
        (0, logger_1.log)(`[hub] Sent execute to satellite — tool="${tool}" requestId=${requestId} (timeout=${timeoutMs}ms)`);
        return promise;
    }
}
exports.HubServer = HubServer;
//# sourceMappingURL=hubServer.js.map