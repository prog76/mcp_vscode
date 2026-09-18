#!/usr/bin/env node
// Runtime module alias: map @vscode-mcp/shared/* to the compiled shared tree
// (tsconfig paths only affect type resolution, not node's runtime require).
try {
    const path = require('path');
    const Module = require('module');
    const origResolve = Module._resolveFilename;
    Module._resolveFilename = function (request: string, ...args: any[]): string {
        if (request.startsWith('@vscode-mcp/shared/')) {
            request = path.join(__dirname, '../../shared/src', request.slice('@vscode-mcp/shared/'.length));
        }
        return origResolve.call(this, request, ...args);
    };
} catch { /* noop */ }

import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { ToolCore, TOOLS } from './toolCore';
import { runStdioServer } from './stdio';
import { createRouter, parseConfig, RouterConfig } from 'mcp-router';
import { CONFIG_DEFAULTS, setConfigOverrides } from './config';
import { parseWsMessage, sendMessage, replaceSocket } from '@vscode-mcp/shared/wsProtocol';
import { initLoggerFile, log, setStdioQuiet } from './logger';
import { setTracer } from '@vscode-mcp/shared/tracer';

type AgentMode = 'server' | 'client' | 'auto' | 'stdio';

interface CliOptions {
    sessionId: string;
    cwd: string;
    hubUrl: string | null;      // ws://host:port — satellite mode when set
    host: string;
    port: number;
    standalone: boolean;        // router mode, never fall back to satellite
    mode: AgentMode;            // manual role selector (CLI --mode / env VSCODE_MCP_AGENT_MODE)
    logFile: string | null;
    shell: string | undefined;
    overrides: Record<string, number>;
    configPath: string | null;  // YAML with extra stdio backends for server mode
}

function usage(): string {
    return [
        'vscode-mcp-agent — standalone router/satellite agent sharing the vscode-mcp extension protocol',
        '',
        'Usage:',
        '  vscode-mcp-agent [options]',
        '',
        'Options:',
        '  --session-id <id>    Session identifier (default: <hostname>/<basename cwd>)',
        '  --cwd <dir>          Default working directory for terminals/execute (default: cwd)',
        '  --hub <ws-url>       Connect as satellite to the router/hub at ws://host:port',
        '  --standalone         Act as the router (serve MCP HTTP + satellite WebSocket) and never connect out',
        '  --mode <m>           Manual mode: server | client | auto | stdio (overrides --standalone; env: VSCODE_MCP_AGENT_MODE)',
        '  --config <path>      Router YAML: extra stdio backends (git, ...) served alongside the agent tools (server mode)',
        '  --host <addr>        Router bind address (default: ' + CONFIG_DEFAULTS.host + ')',
        '  --port <n>           Router port (default: ' + CONFIG_DEFAULTS.port + ')',
        '  --shell <path>       Shell for terminal_create default',
        '  --log-file <path>    Also append logs to this file',
        '  --run-timeout-ms <n>   Default terminal_run/execute timeout',
        '  --wait-timeout-ms <n>  Default terminal_wait timeout',
        '  --max-output-bytes <n> Default execute output cap',
        '  --version            Print version and exit',
        '  --help               This help',
        '',
        'Modes:',
        '  stdio   Plain MCP server over stdio — what mcp-router spawns per session (no ports).',
        '  server  Host the embedded mcp-router: MCP facade at /mcp, satellite intake at /ws,',
        '          own toolset as an in-process backend for this session.',
        '  client  Satellite only: dial --hub and register this session (needs a reachable router).',
        '  auto    Probe the port: satellite if a router answers, host one otherwise (default).',
    ].join('\n');
}

function parseArgs(argv: string[]): CliOptions {
    const cwd = process.cwd();
    const opts: CliOptions = {
        sessionId: `${os.hostname()}/${path.basename(cwd)}`,
        cwd,
        hubUrl: null,
        host: CONFIG_DEFAULTS.host,
        port: CONFIG_DEFAULTS.port,
        standalone: false,
        mode: 'auto',
        logFile: null,
        shell: undefined,
        overrides: {},
        configPath: null,
    };
    // Env-var fallback so containers can pick the role without CLI args.
    const envMode = (process.env.VSCODE_MCP_AGENT_MODE || '').trim().toLowerCase();
    if (envMode) {
        if (envMode !== 'server' && envMode !== 'client' && envMode !== 'auto' && envMode !== 'stdio') {
            throw new Error(`Invalid VSCODE_MCP_AGENT_MODE '${envMode}' (expected server|client|auto|stdio)`);
        }
        opts.mode = envMode;
    }
    let modeSet = false;
    let standaloneSet = false;
    let hubSet = false;
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        const next = (): string => {
            if (i + 1 >= argv.length) throw new Error(`Missing value for ${a}`);
            return argv[++i];
        };
        switch (a) {
            case '--session-id': opts.sessionId = next(); break;
            case '--cwd': opts.cwd = path.resolve(next()); break;
            case '--hub': opts.hubUrl = normalizeHubUrl(next()); hubSet = true; break;
            case '--standalone': opts.standalone = true; standaloneSet = true; break;
            case '--mode': {
                const m = next();
                if (m !== 'server' && m !== 'client' && m !== 'auto' && m !== 'stdio') throw new Error(`Invalid --mode '${m}' (expected server|client|auto|stdio)`);
                modeSet = true;
                opts.mode = m;
                break;
            }
            case '--config': opts.configPath = next(); break;
            case '--host': opts.host = next(); break;
            case '--port': opts.port = parseInt(next(), 10); break;
            case '--shell': opts.shell = next(); break;
            case '--log-file': opts.logFile = next(); break;
            case '--run-timeout-ms': opts.overrides.terminalRunTimeoutMs = parseInt(next(), 10); break;
            case '--wait-timeout-ms': opts.overrides.terminalWaitTimeoutMs = parseInt(next(), 10); break;
            case '--satellite-timeout-ms': opts.overrides.satelliteTimeoutMs = parseInt(next(), 10); break;
            case '--max-output-bytes': opts.overrides.maxOutputBytes = parseInt(next(), 10); break;
            case '--version': console.log(require('../../../package.json').version); process.exit(0); break;
            case '--help': console.log(usage()); process.exit(0); break;
            default: throw new Error(`Unknown option: ${a}\n\n${usage()}`);
        }
    }
    if (modeSet && standaloneSet && opts.mode !== 'server') {
        throw new Error(`--standalone conflicts with --mode ${opts.mode}`);
    }
    if (standaloneSet) opts.mode = 'server';
    if (opts.mode === 'server' && hubSet) {
        throw new Error('--mode server cannot be combined with --hub (server mode never connects out)');
    }
    return opts;
}

function probeHub(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
    return new Promise((resolve) => {
        const req = http.get({ host, port, path: '/health', timeout: timeoutMs }, (res) => {
            res.resume();
            resolve(res.statusCode === 200);
        });
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.on('error', () => resolve(false));
    });
}

function normalizeHubUrl(url: string): string {
    const u = new URL(url);
    if (!u.pathname || u.pathname === '/') u.pathname = '/ws';
    return u.toString();
}

async function main(): Promise<void> {
    let opts: CliOptions;
    try {
        opts = parseArgs(process.argv);
    } catch (e) {
        console.error(String(e));
        process.exit(2);
    }
    initLoggerFile(opts.logFile);
    setTracer((m) => log(m)); // full-power stdout+file tracing for shared modules
    setConfigOverrides(opts.overrides);
    if (opts.mode === 'stdio') {
        // stdio: stdout belongs to the MCP protocol from here on.
        setStdioQuiet();
    }
    if (opts.hubUrl) {
        log(`[main] client mode: connecting as satellite to ${opts.hubUrl}`);
    } else if (opts.mode === 'server') {
        opts.standalone = true;
        log('[main] manual mode: server — acting as router (no probe, no outbound connection)');
    } else if (opts.mode === 'client') {
        opts.hubUrl = normalizeHubUrl(`ws://${opts.host}:${opts.port}`);
        log(`[main] manual mode: client — satellite to ${opts.hubUrl} (no probe, no router fallback)`);
    } else {
        const hubUp = await probeHub(opts.host, opts.port);
        if (hubUp) {
            opts.hubUrl = normalizeHubUrl(`ws://${opts.host}:${opts.port}`);
            log(`[main] auto mode: router reachable at ${opts.host}:${opts.port} — connecting as satellite`);
        } else {
            opts.standalone = true;
            log(`[main] auto mode: no router at ${opts.host}:${opts.port} — acting as router`);
        }
    }

    const pkg = require('../../../package.json');
    const agent = new ToolCore(opts.sessionId, opts.cwd, pkg.version);

    // stdio mode: a plain MCP server over stdio — what a router spawns.
    if (opts.mode === 'stdio') {
        process.on('SIGINT', () => { agent.dispose(); process.exit(0); });
        process.on('SIGTERM', () => { agent.dispose(); process.exit(0); });
        await runStdioServer(agent, `agent-${pkg.version}`);
        return;
    }

    if (opts.hubUrl) {
        // Satellite mode with reconnect, mirroring the extension's retry loop.
        // In auto mode, when the hub connection is lost we re-probe to decide
        // whether to remain a satellite or switch to hub mode.
        let stopped = false;
        const autoMode = opts.mode === 'auto';
        let consecutiveFailures = 0;
        const MAX_FAILURES_BEFORE_REPROBE = 3;
        // Exponential backoff for reconnect attempts (connection-drop and
        // connect-failure paths). Reset to the base delay only after a stable
        // run; a flapping link backs off harder instead of reconnecting instantly,
        // which would churn the hub ("Replacing existing satellite connection")
        // and never stabilise -- this is what made the satellite appear unable
        // to connect to a standalone hub over a lossy link.
        const RECONNECT_BASE_MS = 2000;
        const RECONNECT_MAX_MS = 30000;
        const STABLE_UPTIME_MS = 10000;
        let reconnectDelayMs = RECONNECT_BASE_MS;
        const connect = async (): Promise<'continue' | 'switch-to-hub'> => {
            while (!stopped) {
                let connectedAt = 0;
                try {
                    await satelliteConnect(agent, opts.hubUrl!);
                    log(`[main] connected as satellite (session=\"${opts.sessionId}\")`);
                    consecutiveFailures = 0;
                    connectedAt = Date.now();
                    // satelliteConnect resolves once registered, but the connection
                    // is still live. Do NOT return -- keep this loop iteration
                    // pending until the socket actually closes (hub death / network
                    // drop), then back off and reconnect.
                    await waitForSatelliteDisconnect();
                    if (stopped) return 'continue';
                    // Only reset the backoff after a stable run; a rapidly flapping
                    // link keeps the delay growing so it does not storm the hub.
                    if (connectedAt && Date.now() - connectedAt >= STABLE_UPTIME_MS) {
                        reconnectDelayMs = RECONNECT_BASE_MS;
                    }
                    log(`[main] hub connection lost -- reconnecting in ${reconnectDelayMs}ms`);
                } catch (e) {
                    if (stopped) return 'continue';
                    consecutiveFailures++;
                    log(`[main] satellite connect failed (${e}) -- attempt ${consecutiveFailures}, retrying in ${reconnectDelayMs}ms`);
                    // In auto mode, after multiple consecutive failures,
                    // re-probe the hub to decide if we should switch to hub mode
                    if (autoMode && consecutiveFailures >= MAX_FAILURES_BEFORE_REPROBE) {
                        log(`[main] auto mode: ${consecutiveFailures} consecutive satellite failures -- re-probing hub`);
                        const hubUp = await probeHub(opts.host, opts.port);
                        if (!hubUp) {
                            log(`[main] auto mode: hub no longer reachable after ${consecutiveFailures} failures -- switching to hub mode`);
                            return 'switch-to-hub';
                        }
                        log(`[main] auto mode: hub still reachable, remaining as satellite`);
                        consecutiveFailures = 0;
                    }
                }
                // Backoff before the next attempt on both the connection-drop and
                // the connect-failure path, then grow the delay for the next round.
                if (stopped) return 'continue';
                await new Promise((r) => setTimeout(r, reconnectDelayMs));
                reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_MS);
            }
            return 'continue';
        };
        const shutdown = (): void => {
            stopped = true;
            agent.dispose();
            process.exit(0);
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);

        const action = await connect();
        if (action === 'switch-to-hub') {
            // Hub is gone — switch to router mode. Need to restart the agent process
            // in server mode since the ToolCore and the router have different lifetimes.
            log('[main] auto mode: restarting as router');
            // Clean up the agent before restarting
            agent.dispose();
            // Re-exec ourselves in hub mode
            const args = [
                '--mode', 'server',
                '--host', opts.host,
                '--port', String(opts.port),
                '--session-id', opts.sessionId,
            ];
            if (opts.cwd) args.push('--cwd', opts.cwd);
            if (opts.shell) args.push('--shell', opts.shell);
            if (opts.logFile) args.push('--log-file', opts.logFile);
            log(`[main] auto mode: execing hub with args: ${args.join(' ')}`);
            require('child_process').execFileSync(process.execPath, ['/app/agent/out/agent/src/main.js', ...args], {
                stdio: 'inherit',
                env: { ...process.env, VSCODE_MCP_AGENT_MODE: 'server' }
            });
            return;
        }
        return;
    }

    // Router / standalone mode: the embedded mcp-router replaces HubServer.
    // MCP clients hit the facade (/mcp); this agent's own toolset is an
    // in-process backend that IS our session; dial-in windows are the
    // 'windows' ws backend; extra stdio upstreams (git, ...) come from
    // --config YAML.
    let extraBackends: import('mcp-router').BackendConfig[] = [];
    if (opts.configPath) {
        const text = require('fs').readFileSync(opts.configPath, 'utf8');
        const cfg = parseConfig(text);
        extraBackends = cfg.backends.filter((b) => b.transport === 'stdio');
        log(`[main] config ${opts.configPath}: ${extraBackends.length} stdio backend(s): ${extraBackends.map((b) => b.name).join(', ') || 'none'}`);
    }
    const { router, facade } = await createRouter({
        port: opts.port,
        host: opts.host,
        backends: [
            { name: 'windows', transport: 'ws', scope: 'per-session', wsPath: '/ws' },
            ...extraBackends,
        ],
    });
    await router.addEmbeddedBackend('agent', {
        listTools: async () => TOOLS as unknown as import('mcp-router').ToolDescriptor[],
        callTool: async (_sessionId, name, args) =>
            (await agent.callTool(name, args)) as unknown as import('mcp-router').ToolResult,
    }, { sessionId: opts.sessionId });
    const shutdown = async (): Promise<void> => {
        log('[main] shutting down');
        await facade.close().catch(() => undefined);
        agent.dispose();
        process.exit(0);
    };
    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());
    log(`[main] router listening on http://${opts.host}:${opts.port}/mcp (own session="${opts.sessionId}", ws at /ws)`);
}

// Satellite client: a thin copy of the extension's ServerlessServer WS side
// (register / execute / result / ping-pong), driven by ToolCore.callTool.
import WebSocket from 'ws';


async function satelliteConnect(agent: ToolCore, wsUrl: string): Promise<void> {
    // Disconnect any previous socket without firing a hub-loss signal.
    (satelliteConnect as any).ws && replaceSocket((satelliteConnect as any).ws);
    await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        (satelliteConnect as any).ws = ws;
        let settled = false;
        ws.on('open', () => {
            log(`[satellite] WebSocket open, sending register`);
            sendMessage(ws, { type: 'register', sessionId: (agent as any).sessionId });
            if (!settled) { settled = true; resolve(); }
        });
        ws.on('message', (data) => {
            const msg = parseWsMessage(data);
            if (!msg) return;
            if (msg.type === 'execute') {
                agent.callTool(msg.tool, msg.params || {})
                    .then((result) => sendMessage(ws, { type: 'result', requestId: msg.requestId, result }))
                    .catch((err) => sendMessage(ws, { type: 'error', requestId: msg.requestId, message: String(err) }));
            } else if (msg.type === 'ping') {
                sendMessage(ws, { type: 'pong' });
            }
        });
        ws.on('close', () => {
            (satelliteConnect as any).ws = null;
            if (!settled) { settled = true; reject(new Error('connection closed before register')); }
        });
        ws.on('error', (err) => {
            if (!settled) { settled = true; reject(err); }
        });
    });
}

// Resolves once the current satellite WebSocket has closed (or is already gone).
// The reconnect loop in main() awaits this so a connection that drops is always
// followed by another connect attempt — mirroring the extension's retry loop.
function waitForSatelliteDisconnect(): Promise<void> {
    const ws = (satelliteConnect as any).ws as WebSocket | null;
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        ws.once('close', () => resolve());
    });
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
