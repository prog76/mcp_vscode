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
import { ToolCore } from './toolCore';
import { HubServer } from '@vscode-mcp/shared/hubServer';
import { CONFIG_DEFAULTS, setConfigOverrides } from './config';
import { parseWsMessage, sendMessage, replaceSocket } from '@vscode-mcp/shared/wsProtocol';
import { initLoggerFile, log } from './logger';
import { setTracer } from '@vscode-mcp/shared/tracer';

type AgentMode = 'server' | 'client' | 'auto';

interface CliOptions {
    sessionId: string;
    cwd: string;
    hubUrl: string | null;      // ws://host:port — satellite mode when set
    host: string;
    port: number;
    standalone: boolean;        // hub mode, never fall back to satellite
    mode: AgentMode;            // manual role selector (CLI --mode / env VSCODE_MCP_AGENT_MODE)
    logFile: string | null;
    shell: string | undefined;
    overrides: Record<string, number>;
}

function usage(): string {
    return [
        'vscode-mcp-agent — standalone hub/satellite agent sharing the vscode-mcp extension protocol',
        '',
        'Usage:',
        '  vscode-mcp-agent [options]',
        '',
        'Options:',
        '  --session-id <id>    Session identifier (default: <hostname>/<basename cwd>)',
        '  --cwd <dir>          Default working directory for terminals/execute (default: cwd)',
        '  --hub <ws-url>       Connect as satellite to the hub at ws://host:port',
        '  --standalone         Act as hub (serve MCP HTTP + satellite WebSocket) and never connect out',
        '  --mode <m>           Manual mode: server | client | auto (overrides --standalone; env: VSCODE_MCP_AGENT_MODE)',
        '  --host <addr>        Hub bind address (default: ' + CONFIG_DEFAULTS.host + ')',
        '  --port <n>           Hub port (default: ' + CONFIG_DEFAULTS.port + ')',
        '  --shell <path>       Shell for terminal_create default',
        '  --log-file <path>    Also append logs to this file',
        '  --run-timeout-ms <n>   Default terminal_run/execute timeout',
        '  --wait-timeout-ms <n>  Default terminal_wait timeout',
        '  --max-output-bytes <n> Default execute output cap',
        '  --version            Print version and exit',
        '  --help               This help',
        '',
        'Default (--mode auto): probe the hub port; satellite if reachable, hub otherwise.',
        'Manual modes: --mode server = hub only; --mode client = satellite only (needs --hub, default ws://<host>:<port>).',
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
    };
    // Env-var fallback so containers can pick the role without CLI args.
    const envMode = (process.env.VSCODE_MCP_AGENT_MODE || '').trim().toLowerCase();
    if (envMode) {
        if (envMode !== 'server' && envMode !== 'client' && envMode !== 'auto') {
            throw new Error(`Invalid VSCODE_MCP_AGENT_MODE '${envMode}' (expected server|client|auto)`);
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
                if (m !== 'server' && m !== 'client' && m !== 'auto') throw new Error(`Invalid --mode '${m}' (expected server|client|auto)`);
                modeSet = true;
                opts.mode = m;
                break;
            }
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
    if (opts.hubUrl) {
        log(`[main] client mode: connecting as satellite to ${opts.hubUrl}`);
    } else if (opts.mode === 'server') {
        opts.standalone = true;
        log('[main] manual mode: server — acting as hub (no probe, no outbound connection)');
    } else if (opts.mode === 'client') {
        opts.hubUrl = `ws://${opts.host}:${opts.port}`;
        log(`[main] manual mode: client — satellite to ${opts.hubUrl} (no probe, no hub fallback)`);
    } else {
        const hubUp = await probeHub(opts.host, opts.port);
        if (hubUp) {
            opts.hubUrl = `ws://${opts.host}:${opts.port}`;
            log(`[main] auto mode: hub reachable at ${opts.host}:${opts.port} — connecting as satellite`);
        } else {
            opts.standalone = true;
            log(`[main] auto mode: no hub at ${opts.host}:${opts.port} — acting as hub`);
        }
    }

    const pkg = require('../../../package.json');
    const agent = new ToolCore(opts.sessionId, opts.cwd, pkg.version);

    if (opts.hubUrl) {
        // Satellite mode with reconnect, mirroring the extension's retry loop.
        let stopped = false;
        const connect = async (): Promise<void> => {
            while (!stopped) {
                try {
                    await agent.callTool; // no-op reference to keep TS happy about agent use
                    // connectAsSatellite resolves once registered; on hub loss it
                    // invokes onHubLost and we retry from the top.
                    await new Promise<void>((resolve, reject) => {
                        const onHubLost = (): void => reject(new Error('hub lost'));
                        (agent as any).onHubLost?.(onHubLost);
                        // Use the extension-shaped satellite client embedded in ToolCore via composition:
                        satelliteConnect(agent, opts.hubUrl!, onHubLost).then(resolve, reject);
                    });
                    log(`[main] connected as satellite (session="${opts.sessionId}")`);
                    return;
                } catch (e) {
                    if (stopped) return;
                    log(`[main] satellite connect failed (${e}) — retrying in 5s`);
                    await new Promise((r) => setTimeout(r, 5000));
                }
            }
        };
        const shutdown = (): void => {
            stopped = true;
            agent.dispose();
            process.exit(0);
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
        await connect();
        return;
    }

    // Hub / standalone mode
    const hub = new HubServer(agent, opts.sessionId, `agent-${pkg.version}`, opts.port, opts.host);
    const shutdown = async (): Promise<void> => {
        log('[main] shutting down');
        await hub.stop();
        agent.dispose();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    await hub.start();
    log(`[main] hub listening on http://${opts.host}:${opts.port}/mcp (session="${opts.sessionId}", ws at /ws)`);
}

// Satellite client: a thin copy of the extension's ServerlessServer WS side
// (register / execute / result / ping-pong), driven by ToolCore.callTool.
import WebSocket from 'ws';


async function satelliteConnect(
    agent: ToolCore,
    wsUrl: string,
    onHubLost: () => void
): Promise<void> {
    // Disconnect any previous socket without firing hubLost.
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
            else onHubLost();
        });
        ws.on('error', (err) => {
            if (!settled) { settled = true; reject(err); }
        });
    });
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
