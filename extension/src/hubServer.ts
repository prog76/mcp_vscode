import * as http from 'http';
import WebSocket from 'ws';
import { ServerlessServer, ToolResult, TOOLS } from './serverlessServer';
import { CONFIG_DEFAULTS } from './config';
import { log } from './logger';
import { parseWsMessage, sendMessage, replaceSocket, RequestCorrelator, newRequestId } from './wsProtocol';
import { jsonrpcResult, jsonrpcError, JsonRpcErrorCode } from './mcpResponse';

interface SatelliteInfo {
    sessionId: string;
    ws: WebSocket;
    lastSeen: number;
}

export interface HubEvent {
    type: 'satellite-connected' | 'satellite-disconnected';
    sessionId: string;
    satelliteCount: number;
}

export class HubServer {
    private ownAgent: ServerlessServer;
    private ownSessionId: string;
    private extensionVersion: string;
    private server: http.Server | null = null;
    private wss: WebSocket.Server | null = null;
    private satellites = new Map<string, SatelliteInfo>();
    private _port: number;
    private host: string;
    private heartbeatTimer: NodeJS.Timeout | null = null;
    private eventListeners: Array<(event: HubEvent) => void> = [];
    private satelliteTimeoutMs: number;

    constructor(
        ownAgent: ServerlessServer,
        ownSessionId: string,
        extensionVersion: string,
        port: number,
        host: string = CONFIG_DEFAULTS.host,
        satelliteTimeoutMs: number = CONFIG_DEFAULTS.satelliteTimeoutMs
    ) {
        this.ownAgent = ownAgent;
        this.ownSessionId = ownSessionId;
        this.extensionVersion = extensionVersion;
        this._port = port;
        this.host = host;
        this.satelliteTimeoutMs = satelliteTimeoutMs;
    }

    get port(): number {
        return this._port;
    }

    get satelliteCount(): number {
        return this.satellites.size;
    }

    get satelliteIds(): string[] {
        return Array.from(this.satellites.keys());
    }

    onEvent(listener: (event: HubEvent) => void): void {
        this.eventListeners.push(listener);
    }

    private emitEvent(event: HubEvent): void {
        for (const listener of this.eventListeners) {
            try { listener(event); } catch { /* noop */ }
        }
    }

    async start(): Promise<void> {
        this.server = http.createServer((req, res) => {
            this.handleHttpRequest(req, res);
        });

        await new Promise<void>((resolve, reject) => {
            this.server!.once('error', reject);
            this.server!.listen(this._port, this.host, () => {
                this.server!.removeListener('error', reject);
                resolve();
            });
        });

        this.wss = new WebSocket.Server({ server: this.server, path: '/ws' });
        this.wss.on('connection', (ws) => {
            this.handleNewConnection(ws);
        });

        // Broadcast heartbeat to satellites every 10s; drop stale ones
        this.heartbeatTimer = setInterval(() => {
            const now = Date.now();
            for (const [sessionId, info] of this.satellites.entries()) {
                if (now - info.lastSeen > 30000) {
                    this.satellites.delete(sessionId);
                    try { info.ws.close(); } catch { /* noop */ }
                }
            }
            for (const info of this.satellites.values()) {
                try {
                    info.ws.send(JSON.stringify({ type: 'ping' }));
                } catch { /* noop */ }
            }
        }, 10000);
    }

    async stop(): Promise<void> {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        for (const info of this.satellites.values()) {
            try { info.ws.close(); } catch { /* noop */ }
        }
        this.satellites.clear();
        if (this.wss) {
            this.wss.close();
            this.wss = null;
        }
        if (this.server) {
            await new Promise<void>((resolve) => this.server!.close(() => resolve()));
            this.server = null;
        }
    }

    private handleNewConnection(ws: WebSocket): void {
        let registered = false;
        const timeout = setTimeout(() => {
            if (!registered) {
                ws.close(4001, 'Register timeout');
            }
        }, 5000);

        ws.on('message', (data) => {
            const msg = parseWsMessage(data);
            if (!msg) return;

            switch (msg.type) {
                case 'register':
                    if (msg.sessionId) {
                        registered = true;
                        clearTimeout(timeout);
                        const existing = this.satellites.get(msg.sessionId);
                        if (existing && existing.ws !== ws) {
                            log(`[hub] Replacing existing satellite connection for "${msg.sessionId}"`);
                            replaceSocket(existing.ws);
                        }
                        log(`[hub] Satellite registered: "${msg.sessionId}"`);
                        this.satellites.set(msg.sessionId, { sessionId: msg.sessionId, ws, lastSeen: Date.now() });
                        sendMessage(ws, { type: 'registered', sessionId: msg.sessionId });
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
                    log(`[hub] Satellite disconnected: "${sessionId}"`);
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

    private pendingRequests = new RequestCorrelator<ToolResult>();

    private handleSatelliteResult(msg: any): void {
        log(`[hub] Satellite ${msg.type} for requestId=${msg.requestId}`);
        if (msg.type === 'error') {
            this.pendingRequests.reject(msg.requestId, new Error(msg.message || 'Satellite error'));
        } else {
            this.pendingRequests.resolve(msg.requestId, msg.result as ToolResult);
        }
    }

    private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
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
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(jsonrpcError(null, JsonRpcErrorCode.ParseError, String(e))));
                }
            });
            return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
    }

    private async handleMcpRequest(msg: any): Promise<any> {
        if (msg.method === 'initialize') {
            return jsonrpcResult(msg.id, {
                protocolVersion: '2025-03-26',
                capabilities: { tools: {} },
                serverInfo: { name: 'vscode-mcp-hub', version: this.extensionVersion },
            });
        }

        if (msg.method === 'notifications/initialized') {
            return jsonrpcResult(msg.id, {});
        }

        if (msg.method === 'tools/list') {
            return jsonrpcResult(msg.id, { tools: TOOLS });
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
                return jsonrpcResult(msg.id, {
                    content: [{ type: 'text', text: sessions.length ? sessions.join('\n') : 'No sessions.' }],
                });
            }

            const targetSession = args.session_id;

            // SECURITY: session_id is required so the agent cannot discover or
            // guess workspaces — it must be told which one to target.
            if (!targetSession) {
                return jsonrpcError(msg.id, JsonRpcErrorCode.InvalidParams,
                    'session_id is required. The agent must be told which workspace to target — it cannot discover or guess workspaces.');
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
                log(`[hub] Routing tool="${tool}" to own session "${targetSession}"`);
                try {
                    const result = await this.ownAgent.callTool(tool, args);
                    return jsonrpcResult(msg.id, result);
                } catch (e) {
                    return jsonrpcError(msg.id, JsonRpcErrorCode.InternalError, String(e));
                }
            }

            const satellite = this.satellites.get(targetSession);
            if (!satellite) {
                log(`[hub] Cannot route tool="${tool}": no session "${targetSession}"`);
                return jsonrpcError(msg.id, JsonRpcErrorCode.InvalidParams, `No session registered with id: ${targetSession}`);
            }

            const requestId = newRequestId();
            log(`[hub] Routing tool="${tool}" to satellite "${targetSession}" (requestId=${requestId})`);
            try {
                const result = await this.executeOnSatellite(satellite.ws, requestId, tool, args);
                return jsonrpcResult(msg.id, result);
            } catch (e) {
                return jsonrpcError(msg.id, JsonRpcErrorCode.InternalError, String(e));
            }
        }

        return jsonrpcError(msg.id ?? null, JsonRpcErrorCode.MethodNotFound, `Method not found: ${msg.method}`);
    }

    private resolveSatelliteWaitMs(tool: string, args: Record<string, unknown>): number {
        const base = this.satelliteTimeoutMs;
        if (tool === 'terminal_run' || tool === 'terminal_wait') {
            const fromArgs = typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined;
            const toolDefault =
                tool === 'terminal_wait'
                    ? CONFIG_DEFAULTS.terminalWaitTimeoutMs
                    : CONFIG_DEFAULTS.terminalRunTimeoutMs;
            return Math.max(base, fromArgs ?? toolDefault);
        }
        return base;
    }

    private executeOnSatellite(ws: WebSocket, requestId: string, tool: string, args: any): Promise<ToolResult> {
        const timeoutMs = this.resolveSatelliteWaitMs(tool, args || {});
        const promise = this.pendingRequests.register(requestId, timeoutMs, (id) => {
            log(`[hub] Satellite timed out for requestId=${id} tool="${tool}" after ${timeoutMs}ms`);
        });

        const sent = sendMessage(ws, {
            type: 'execute',
            requestId,
            tool,
            params: args,
        });
        if (!sent) {
            const err = new Error(`Failed to send execute to satellite — tool="${tool}" requestId=${requestId}`);
            this.pendingRequests.reject(requestId, err);
            log(`[hub] Failed to send execute to satellite — tool="${tool}" requestId=${requestId}`);
            return promise;
        }
        log(`[hub] Sent execute to satellite — tool="${tool}" requestId=${requestId} (timeout=${timeoutMs}ms)`);
        return promise;
    }
}