import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ToolCore, TOOLS } from './toolCore';
import { log } from './logger';

/**
 * stdio mode: serve the agent's toolset as a plain MCP server over stdio.
 *
 * This is the transport a router spawns: `mcp-router` (or any MCP client)
 * launches this process per session and speaks the standard MCP protocol —
 * no WebSocket, no hub. One process == one session's world (cwd), matching
 * the router's per-session stdio isolation invariant.
 */
export async function runStdioServer(agent: ToolCore, version: string): Promise<void> {
    const server = new Server(
        { name: 'vscode-mcp-agent', version },
        { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: TOOLS as unknown as Array<Record<string, unknown>>,
    }));

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
        const name = req.params.name;
        const args = (req.params.arguments ?? {}) as Record<string, unknown>;
        // ToolCore ignores session_id (its world is fixed by the spawning
        // router); passing it through keeps the shared strict schemas happy.
        const result = await agent.callTool(name, args);
        return result as unknown as Record<string, unknown>;
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);
    log('[stdio] MCP server ready on stdio');
}
