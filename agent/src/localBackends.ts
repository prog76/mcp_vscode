import { BackendConfig, StdioBackendInstance, ToolDescriptor, ToolResult, parseConfig } from 'mcp-router';
import { TOOLS } from './toolCore';
import { log } from './logger';
import * as fs from 'fs';

/**
 * Local MCP backends for a SATELLITE agent.
 *
 * A satellite is one workspace (this container), so its backends are its own:
 * each spawns here, in this container, against this container's mount. That is
 * the whole point — a git child spawned in another container would serve that
 * container's filesystem while the agent believes it is working here.
 *
 * Why this exists: the faceted router serves one GLOBAL tool catalog (MCP
 * `tools/list` carries no session), so every workspace must advertise the same
 * tools. A satellite that answered only its own ToolCore tools would leave the
 * catalog incomplete, and a `git_*` call sent to it would fail as unknown.
 *
 * Instances are per-backend and long-lived (one git process per container, not
 * per call), and are spawned on first catalog request — advertising a tool set
 * IS a use, so `lazy` cannot defer that. What `lazy` still buys is that the
 * cost lands at registration rather than at container start.
 */
export class LocalBackends {
    private instances = new Map<string, StdioBackendInstance>();
    /** tool name (as advertised) -> owning backend */
    private owned = new Map<string, string>();
    private tools: ToolDescriptor[] = [];
    /**
     * The in-flight (or completed) startup. Memoised as a promise, NOT a
     * boolean: a concurrent caller must await the same work rather than see a
     * half-initialised catalog. See the note in start().
     */
    private starting: Promise<void> | null = null;

    private constructor(private readonly backends: BackendConfig[], private readonly sessionId: string) {}

    /** A satellite with no configured backends (server mode, tests). */
    static none(): LocalBackends {
        return new LocalBackends([], '');
    }
    /**
     * Read the same router config the hosting container uses, keeping only the
     * spawnable stdio backends. A ws backend is meaningless here (a satellite
     * does not accept registrations) and an embedded one is code, not config.
     */
    static fromConfig(configPath: string | null, sessionId: string): LocalBackends {
        if (!configPath) return new LocalBackends([], sessionId);
        const cfg = parseConfig(fs.readFileSync(configPath, 'utf8'));
        const backends = cfg.backends.filter((b) => b.transport === 'stdio');
        log(`[local-backends] ${backends.length} stdio backend(s): ${backends.map((b) => b.name).join(', ') || 'none'}`);
        return new LocalBackends(backends, sessionId);
    }

    /** Spawn each backend once and fold its tools into the catalog. */
    private start(): Promise<void> {
        if (!this.starting) this.starting = this.spawnAll();
        return this.starting;
    }

    private async spawnAll(): Promise<void> {
        for (const cfg of this.backends) {
            let inst = this.instances.get(cfg.name);
            if (!inst) {
                // One instance for this container's single session: the instance
                // IS this session, which is exactly `ownSession` semantics.
                inst = new StdioBackendInstance(cfg, this.sessionId);
                this.instances.set(cfg.name, inst);
            }
            try {
                const tools = await inst.listTools();
                const prefix = cfg.prefix ? `${cfg.prefix}_` : '';
                for (const t of tools) {
                    const name = prefix + t.name;
                    this.owned.set(name, cfg.name);
                    this.tools.push({ ...t, name });
                }
                log(`[local-backends] backend "${cfg.name}": ${tools.length} tools`);
            } catch (e) {
                // A backend that cannot start must not take the satellite down:
                // the window/terminal tools still work, and the failure is
                // visible as the missing tools rather than as a dead session.
                log(`[local-backends] backend "${cfg.name}" failed: ${String(e)}`);
            }
        }
    }

    /** The full catalog this satellite serves: local backends + the agent toolset. */
    async listTools(): Promise<ToolDescriptor[]> {
        await this.start();
        return [...this.tools, ...(TOOLS as unknown as ToolDescriptor[])];
    }

    owns(name: string): boolean {
        return this.owned.has(name);
    }

    /**
     * Run a local-backend tool. The router has already stripped `session_id`
     * for non-embedded transports, but a satellite may be called directly, so
     * strip it here too: backend schemas are strict and a foreign key is an
     * error, not a hint.
     */
    async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
        await this.start();
        const backendName = this.owned.get(name);
        if (!backendName) throw new Error(`no local backend owns tool "${name}"`);
        const cfg = this.backends.find((b) => b.name === backendName)!;
        const prefix = cfg.prefix ? `${cfg.prefix}_` : '';
        const forwarded: Record<string, unknown> = { ...args };
        delete forwarded.session_id;
        const inst = this.instances.get(backendName)!;
        return inst.callTool(name.slice(prefix.length), forwarded);
    }

    async close(): Promise<void> {
        for (const inst of this.instances.values()) await inst.close();
        this.instances.clear();
    }
}
