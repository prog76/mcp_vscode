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
const serverlessServer_1 = require("./serverlessServer");
const logger_1 = require("./logger");
class HubServer {
    constructor(ownAgent, ownSessionId, extensionVersion, port, host = '127.0.0.1', satelliteTimeoutMs = 120000) {
        this.server = null;
        this.wss = null;
        this.satellites = new Map();
        this.heartbeatTimer = null;
        this.eventListeners = [];
        this.pendingRequests = new Map();
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
            let msg;
            try {
                msg = JSON.parse(data.toString());
            }
            catch {
                return;
            }
            switch (msg.type) {
                case 'register':
                    if (msg.sessionId) {
                        registered = true;
                        clearTimeout(timeout);
                        (0, logger_1.log)(`[hub] Satellite registered: "${msg.sessionId}"`);
                        this.satellites.set(msg.sessionId, { sessionId: msg.sessionId, ws, lastSeen: Date.now() });
                        ws.send(JSON.stringify({ type: 'registered', sessionId: msg.sessionId }));
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
        const pending = this.pendingRequests.get(msg.requestId);
        if (!pending)
            return;
        this.pendingRequests.delete(msg.requestId);
        clearTimeout(pending.timeout);
        (0, logger_1.log)(`[hub] Satellite ${msg.type} for requestId=${msg.requestId}`);
        if (msg.type === 'error') {
            pending.reject(new Error(msg.message || 'Satellite error'));
        }
        else {
            pending.resolve(msg.result);
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
            const sessions = [
                { sessionId: this.ownSessionId, own: true },
                ...Array.from(this.satellites.values()).map((s) => ({ sessionId: s.sessionId, own: false })),
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
                    res.end(JSON.stringify({
                        jsonrpc: '2.0',
                        id: null,
                        error: { code: -32700, message: String(e) },
                    }));
                }
            });
            return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
    }
    async handleMcpRequest(msg) {
        if (msg.method === 'initialize') {
            return {
                jsonrpc: '2.0',
                id: msg.id,
                result: {
                    protocolVersion: '2025-03-26',
                    capabilities: { tools: {} },
                    serverInfo: { name: 'vscode-mcp-hub', version: this.extensionVersion },
                },
            };
        }
        if (msg.method === 'notifications/initialized') {
            return { jsonrpc: '2.0', id: msg.id, result: {} };
        }
        if (msg.method === 'tools/list') {
            return {
                jsonrpc: '2.0',
                id: msg.id,
                result: { tools: serverlessServer_1.TOOLS },
            };
        }
        if (msg.method === 'tools/call') {
            const tool = msg.params?.name;
            const args = msg.params?.arguments || {};
            if (tool === 'terminal_list_sessions') {
                const sessions = [
                    `${this.ownSessionId} (hub)`,
                    ...Array.from(this.satellites.keys()).map((s) => `${s} (satellite)`),
                ];
                return {
                    jsonrpc: '2.0',
                    id: msg.id,
                    result: {
                        content: [{ type: 'text', text: sessions.length ? sessions.join('\n') : 'No sessions.' }],
                    },
                };
            }
            const targetSession = args.session_id;
            if (!targetSession || targetSession === this.ownSessionId) {
                try {
                    const result = await this.ownAgent.callTool(tool, args);
                    return { jsonrpc: '2.0', id: msg.id, result };
                }
                catch (e) {
                    return {
                        jsonrpc: '2.0',
                        id: msg.id,
                        error: { code: -32603, message: String(e) },
                    };
                }
            }
            const satellite = this.satellites.get(targetSession);
            if (!satellite) {
                (0, logger_1.log)(`[hub] Cannot route tool="${tool}": no satellite "${targetSession}"`);
                return {
                    jsonrpc: '2.0',
                    id: msg.id,
                    error: { code: -32602, message: `No session registered with id: ${targetSession}` },
                };
            }
            const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            (0, logger_1.log)(`[hub] Routing tool="${tool}" to satellite "${targetSession}" (requestId=${requestId})`);
            try {
                const result = await this.executeOnSatellite(satellite.ws, requestId, tool, args);
                return { jsonrpc: '2.0', id: msg.id, result };
            }
            catch (e) {
                return {
                    jsonrpc: '2.0',
                    id: msg.id,
                    error: { code: -32603, message: String(e) },
                };
            }
        }
        return {
            jsonrpc: '2.0',
            id: msg.id ?? null,
            error: { code: -32601, message: `Method not found: ${msg.method}` },
        };
    }
    executeOnSatellite(ws, requestId, tool, args) {
        return new Promise((resolve, reject) => {
            const timeoutMs = this.satelliteTimeoutMs;
            const timeout = setTimeout(() => {
                this.pendingRequests.delete(requestId);
                (0, logger_1.log)(`[hub] Satellite timed out for requestId=${requestId} tool="${tool}" after ${timeoutMs}ms`);
                reject(new Error(`Satellite timed out for tool: ${tool}`));
            }, timeoutMs);
            this.pendingRequests.set(requestId, { resolve, reject, timeout });
            try {
                ws.send(JSON.stringify({
                    type: 'execute',
                    requestId,
                    tool,
                    params: args,
                }));
                (0, logger_1.log)(`[hub] Sent execute to satellite — tool="${tool}" requestId=${requestId} (timeout=${timeoutMs}ms)`);
            }
            catch (e) {
                this.pendingRequests.delete(requestId);
                clearTimeout(timeout);
                (0, logger_1.log)(`[hub] Failed to send execute to satellite — tool="${tool}" requestId=${requestId}: ${e}`);
                reject(e);
            }
        });
    }
}
exports.HubServer = HubServer;
//# sourceMappingURL=hubServer.js.map