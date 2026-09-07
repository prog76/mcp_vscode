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
const http = __importStar(require("http"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const toolCore_1 = require("./toolCore");
const hubServer_1 = require("./hubServer");
const config_1 = require("./config");
const logger_1 = require("./logger");
function usage() {
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
        '  --host <addr>        Hub bind address (default: ' + config_1.CONFIG_DEFAULTS.host + ')',
        '  --port <n>           Hub port (default: ' + config_1.CONFIG_DEFAULTS.port + ')',
        '  --shell <path>       Shell for terminal_create default',
        '  --log-file <path>    Also append logs to this file',
        '  --run-timeout-ms <n>   Default terminal_run/execute timeout',
        '  --wait-timeout-ms <n>  Default terminal_wait timeout',
        '  --max-output-bytes <n> Default execute output cap',
        '  --version            Print version and exit',
        '  --help               This help',
        '',
        'Default (no --hub / --standalone): auto — probe the hub port; satellite if reachable, hub otherwise.',
    ].join('\n');
}
function parseArgs(argv) {
    const cwd = process.cwd();
    const opts = {
        sessionId: `${os.hostname()}/${path.basename(cwd)}`,
        cwd,
        hubUrl: null,
        host: config_1.CONFIG_DEFAULTS.host,
        port: config_1.CONFIG_DEFAULTS.port,
        standalone: false,
        logFile: null,
        shell: undefined,
        overrides: {},
    };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        const next = () => {
            if (i + 1 >= argv.length)
                throw new Error(`Missing value for ${a}`);
            return argv[++i];
        };
        switch (a) {
            case '--session-id':
                opts.sessionId = next();
                break;
            case '--cwd':
                opts.cwd = path.resolve(next());
                break;
            case '--hub':
                opts.hubUrl = normalizeHubUrl(next());
                break;
            case '--standalone':
                opts.standalone = true;
                break;
            case '--host':
                opts.host = next();
                break;
            case '--port':
                opts.port = parseInt(next(), 10);
                break;
            case '--shell':
                opts.shell = next();
                break;
            case '--log-file':
                opts.logFile = next();
                break;
            case '--run-timeout-ms':
                opts.overrides.terminalRunTimeoutMs = parseInt(next(), 10);
                break;
            case '--wait-timeout-ms':
                opts.overrides.terminalWaitTimeoutMs = parseInt(next(), 10);
                break;
            case '--satellite-timeout-ms':
                opts.overrides.satelliteTimeoutMs = parseInt(next(), 10);
                break;
            case '--max-output-bytes':
                opts.overrides.maxOutputBytes = parseInt(next(), 10);
                break;
            case '--version':
                console.log(require('../package.json').version);
                process.exit(0);
                break;
            case '--help':
                console.log(usage());
                process.exit(0);
                break;
            default: throw new Error(`Unknown option: ${a}\n\n${usage()}`);
        }
    }
    return opts;
}
function probeHub(host, port, timeoutMs = 1500) {
    return new Promise((resolve) => {
        const req = http.get({ host, port, path: '/health', timeout: timeoutMs }, (res) => {
            res.resume();
            resolve(res.statusCode === 200);
        });
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.on('error', () => resolve(false));
    });
}
function normalizeHubUrl(url) {
    const u = new URL(url);
    if (!u.pathname || u.pathname === '/')
        u.pathname = '/ws';
    return u.toString();
}
async function main() {
    let opts;
    try {
        opts = parseArgs(process.argv);
    }
    catch (e) {
        console.error(String(e));
        process.exit(2);
    }
    (0, logger_1.initLoggerFile)(opts.logFile);
    (0, config_1.setConfigOverrides)(opts.overrides);
    if (!opts.hubUrl && !opts.standalone) {
        const hubUp = await probeHub(opts.host, opts.port);
        if (hubUp) {
            opts.hubUrl = `ws://${opts.host}:${opts.port}`;
            (0, logger_1.log)(`[main] auto mode: hub reachable at ${opts.host}:${opts.port} — connecting as satellite`);
        }
        else {
            opts.standalone = true;
            (0, logger_1.log)(`[main] auto mode: no hub at ${opts.host}:${opts.port} — acting as hub`);
        }
    }
    const pkg = require('../package.json');
    const agent = new toolCore_1.ToolCore(opts.sessionId, opts.cwd, pkg.version);
    if (opts.hubUrl) {
        // Satellite mode with reconnect, mirroring the extension's retry loop.
        let stopped = false;
        const connect = async () => {
            while (!stopped) {
                try {
                    await agent.callTool; // no-op reference to keep TS happy about agent use
                    // connectAsSatellite resolves once registered; on hub loss it
                    // invokes onHubLost and we retry from the top.
                    await new Promise((resolve, reject) => {
                        const onHubLost = () => reject(new Error('hub lost'));
                        agent.onHubLost?.(onHubLost);
                        // Use the extension-shaped satellite client embedded in ToolCore via composition:
                        satelliteConnect(agent, opts.hubUrl, onHubLost).then(resolve, reject);
                    });
                    (0, logger_1.log)(`[main] connected as satellite (session="${opts.sessionId}")`);
                    return;
                }
                catch (e) {
                    if (stopped)
                        return;
                    (0, logger_1.log)(`[main] satellite connect failed (${e}) — retrying in 5s`);
                    await new Promise((r) => setTimeout(r, 5000));
                }
            }
        };
        const shutdown = () => {
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
    const hub = new hubServer_1.HubServer(agent, opts.sessionId, `agent-${pkg.version}`, opts.port, opts.host);
    const shutdown = async () => {
        (0, logger_1.log)('[main] shutting down');
        await hub.stop();
        agent.dispose();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    await hub.start();
    (0, logger_1.log)(`[main] hub listening on http://${opts.host}:${opts.port}/mcp (session="${opts.sessionId}", ws at /ws)`);
}
// Satellite client: a thin copy of the extension's ServerlessServer WS side
// (register / execute / result / ping-pong), driven by ToolCore.callTool.
const ws_1 = __importDefault(require("ws"));
const wsProtocol_1 = require("./wsProtocol");
async function satelliteConnect(agent, wsUrl, onHubLost) {
    // Disconnect any previous socket without firing hubLost.
    satelliteConnect.ws && (0, wsProtocol_1.replaceSocket)(satelliteConnect.ws);
    await new Promise((resolve, reject) => {
        const ws = new ws_1.default(wsUrl);
        satelliteConnect.ws = ws;
        let settled = false;
        ws.on('open', () => {
            (0, logger_1.log)(`[satellite] WebSocket open, sending register`);
            (0, wsProtocol_1.sendMessage)(ws, { type: 'register', sessionId: agent.sessionId });
            if (!settled) {
                settled = true;
                resolve();
            }
        });
        ws.on('message', (data) => {
            const msg = (0, wsProtocol_1.parseWsMessage)(data);
            if (!msg)
                return;
            if (msg.type === 'execute') {
                agent.callTool(msg.tool, msg.params || {})
                    .then((result) => (0, wsProtocol_1.sendMessage)(ws, { type: 'result', requestId: msg.requestId, result }))
                    .catch((err) => (0, wsProtocol_1.sendMessage)(ws, { type: 'error', requestId: msg.requestId, message: String(err) }));
            }
            else if (msg.type === 'ping') {
                (0, wsProtocol_1.sendMessage)(ws, { type: 'pong' });
            }
        });
        ws.on('close', () => {
            satelliteConnect.ws = null;
            if (!settled) {
                settled = true;
                reject(new Error('connection closed before register'));
            }
            else
                onHubLost();
        });
        ws.on('error', (err) => {
            if (!settled) {
                settled = true;
                reject(err);
            }
        });
    });
}
main().catch((e) => {
    console.error(e);
    process.exit(1);
});
//# sourceMappingURL=main.js.map