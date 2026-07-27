#!/usr/bin/env python3
"""
VS Code MCP Server - Central server that routes MCP tool calls to VS Code extensions.

Architecture:
- Single MCP endpoint at /mcp
- All tools take 'workspace' as first argument
- VS Code extensions connect via WebSocket at /ws
- Server routes tool calls to the correct extension over the WebSocket

Usage:
    python -m vscode_mcp                    # Run on default port 9876
    python -m vscode_mcp --port 9999         # Custom port
    vscode-mcp-server --port 9999             # After pip install
"""

import asyncio
import json
import logging
import uuid
from typing import Any, Dict, Optional
from datetime import datetime

import uvicorn
from starlette.applications import Starlette
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Mount, Route, WebSocketRoute
from starlette.websockets import WebSocket, WebSocketDisconnect

from mcp.server.fastmcp import FastMCP

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
log = logging.getLogger("vscode-mcp")

# Configuration
DEFAULT_PORT = 9876

# Global state
# workspace_name -> {websocket: WebSocket, metadata: dict}
extensions: Dict[str, Dict[str, Any]] = {}

# Pending tool execution requests: request_id -> asyncio.Future
_pending_requests: Dict[str, asyncio.Future] = {}


# ---------------------------------------------------------------------------
# Extension Registry (WebSocket-based)
# ---------------------------------------------------------------------------

def get_extension(workspace: str) -> Optional[Dict[str, Any]]:
    """Get registered extension for workspace, or None if not found."""
    # Try exact match first
    ext = extensions.get(workspace)

    # If not found, try to match by workspace name prefix (for dev containers)
    if not ext:
        for ws, ext_data in extensions.items():
            if ws.startswith(workspace) or workspace in ws:
                ext = ext_data
                log.debug("Matched workspace '%s' to registered '%s'", workspace, ws)
                break

    if not ext:
        return None

    # Check if WebSocket is still connected
    ws = ext.get('websocket')
    if ws is None:
        log.warning("Extension for workspace '%s' has no WebSocket (disconnected)", workspace)
        del extensions[workspace]
        return None

    return ext


async def call_extension(workspace: str, tool: str, arguments: Dict[str, Any]) -> str:
    """Forward tool call to VS Code extension via WebSocket.

    Sends a message over the extension's WebSocket and waits for the response.
    """
    ext = get_extension(workspace)
    if not ext:
        return (
            f"Error: No VS Code instance registered for workspace '{workspace}'. "
            "Start VS Code with the vscode-mcp extension activated."
        )

    ws = ext['websocket']
    request_id = str(uuid.uuid4())
    future: asyncio.Future = asyncio.get_event_loop().create_future()
    _pending_requests[request_id] = future

    try:
        # Send execute request over WebSocket
        await ws.send_json({
            "type": "execute",
            "requestId": request_id,
            "tool": tool,
            "arguments": arguments,
        })

        # Wait for response with timeout
        try:
            result = await asyncio.wait_for(future, timeout=30.0)
            return result
        except asyncio.TimeoutError:
            return f"Error: Timeout waiting for extension '{workspace}' to execute {tool}"
    except Exception as e:
        log.error("Error calling extension for workspace '%s': %s", workspace, e)
        return f"Error: {str(e)}"
    finally:
        _pending_requests.pop(request_id, None)


# ---------------------------------------------------------------------------
# MCP Server Tools
# ---------------------------------------------------------------------------

from mcp.server.transport_security import TransportSecuritySettings

# Disable DNS rebinding protection for browser extension compatibility
transport_security = TransportSecuritySettings(enable_dns_rebinding_protection=False)
mcp = FastMCP("vscode-mcp", transport_security=transport_security, stateless_http=True)


@mcp.tool(structured_output=False)
async def terminal_create(workspaceId: str, name: str, cwd: str = "") -> str:
    """Create a new terminal in the specified VS Code workspace.

    Args:
        workspaceId: The workspace identifier string (the user will provide this).
                    Example format: 'vsc-mcp [Dev Container: vsc-mcp @ VDI-LS]'
        name: The terminal name.
        cwd: Working directory (filesystem path) for the terminal.
    """
    log.info("Creating terminal in workspace '%s': %s", workspaceId, name)
    return await call_extension(workspaceId, 'terminal_create', {
        'name': name,
        'cwd': cwd
    })


@mcp.tool(structured_output=False)
async def terminal_exec(workspaceId: str, terminal_id: str, command: str) -> str:
    """Execute a command in a terminal.

    Args:
        workspaceId: The workspace identifier string (the user will provide this).
        terminal_id: The terminal ID.
        command: The command to execute.
    """
    log.info("Executing in workspace '%s' terminal %s: %s", workspaceId, terminal_id, command)
    return await call_extension(workspaceId, 'terminal_exec', {
        'terminal_id': terminal_id,
        'command': command
    })


@mcp.tool(structured_output=False)
async def terminal_read(workspaceId: str, terminal_id: str, since_index: int = 0) -> str:
    """Read terminal output since last read.

    Args:
        workspaceId: The workspace identifier string (the user will provide this).
        terminal_id: The terminal ID.
        since_index: Output index offset.
    """
    log.debug("Reading terminal output from workspace '%s' terminal %s since %d",
              workspaceId, terminal_id, since_index)
    return await call_extension(workspaceId, 'terminal_read', {
        'terminal_id': terminal_id,
        'since_index': since_index
    })


@mcp.tool(structured_output=False)
async def terminal_list(workspaceId: str) -> str:
    """List all active terminals in a workspace.

    Args:
        workspaceId: The workspace identifier string (the user will provide this).
    """
    log.debug("Listing terminals in workspace '%s'", workspaceId)
    return await call_extension(workspaceId, 'terminal_list', {})


@mcp.tool(structured_output=False)
async def terminal_kill(workspaceId: str, terminal_id: str) -> str:
    """Kill a terminal.

    Args:
        workspaceId: The workspace identifier string (the user will provide this).
        terminal_id: The terminal ID.
    """
    log.info("Killing terminal %s in workspace '%s'", terminal_id, workspaceId)
    return await call_extension(workspaceId, 'terminal_kill', {
        'terminal_id': terminal_id
    })


# ---------------------------------------------------------------------------
# WebSocket Endpoint
# ---------------------------------------------------------------------------

async def handle_websocket(ws: WebSocket):
    """Handle WebSocket connections from VS Code extensions.

    Protocol:
    - Extension connects and sends: {"type": "register", "workspace": "..."}
    - Server sends: {"type": "execute", "requestId": "...", "tool": "...", "arguments": {...}}
    - Extension responds: {"type": "result", "requestId": "...", "result": "..."}
    """
    await ws.accept()
    log.info("New WebSocket connection accepted")

    workspace = None
    try:
        while True:
            data = await ws.receive_json()
            msg_type = data.get("type")

            if msg_type == "register":
                workspace = data.get("workspace")
                if not workspace:
                    await ws.send_json({"type": "error", "message": "Missing workspace"})
                    continue

                # Store the WebSocket connection
                extensions[workspace] = {
                    'websocket': ws,
                    'registered_at': datetime.now().isoformat(),
                    'metadata': data.get('metadata', {}),
                }
                log.info("Registered extension for workspace: %s", workspace)
                await ws.send_json({
                    "type": "registered",
                    "workspace": workspace,
                })

            elif msg_type == "result":
                request_id = data.get("requestId")
                result = data.get("result", "")
                if request_id and request_id in _pending_requests:
                    future = _pending_requests[request_id]
                    if not future.done():
                        future.set_result(result)
                else:
                    log.warning("Received result for unknown request: %s", request_id)

            elif msg_type == "ping":
                await ws.send_json({"type": "pong"})

            elif msg_type == "error":
                request_id = data.get("requestId")
                error_msg = data.get("message", "Unknown error")
                log.error("Extension error for request %s: %s", request_id, error_msg)
                if request_id and request_id in _pending_requests:
                    future = _pending_requests[request_id]
                    if not future.done():
                        future.set_result(f"Error: {error_msg}")

            else:
                log.warning("Unknown WebSocket message type: %s", msg_type)
                await ws.send_json({
                    "type": "error",
                    "message": f"Unknown message type: {msg_type}",
                })

    except WebSocketDisconnect:
        log.info("WebSocket disconnected for workspace: %s", workspace)
    except Exception as e:
        log.error("WebSocket error for workspace %s: %s", workspace, e)
    finally:
        # Clean up on disconnect
        if workspace and workspace in extensions:
            del extensions[workspace]
            log.info("Removed extension for workspace: %s", workspace)

        # Fail any pending requests for this workspace
        for request_id, future in list(_pending_requests.items()):
            if not future.done():
                future.set_result(f"Error: Extension '{workspace}' disconnected")


# ---------------------------------------------------------------------------
# HTTP Endpoints (health, workspaces list)
# ---------------------------------------------------------------------------

async def handle_list_workspaces(request: Request):
    """List all registered workspaces."""
    workspaces = []
    for ws, ext in extensions.items():
        workspaces.append({
            "name": ws,
            "connected": ext.get('websocket') is not None,
            "registered_at": ext.get('registered_at', ''),
        })

    return JSONResponse({"workspaces": workspaces})


async def handle_health(request: Request):
    """Health check endpoint."""
    return JSONResponse({
        "status": "ok",
        "extensions_count": len(extensions),
        "workspaces": list(extensions.keys())
    })


# ---------------------------------------------------------------------------
# CORS Middleware
# ---------------------------------------------------------------------------

class CORSSupportMiddleware(BaseHTTPMiddleware):
    """Custom middleware to add CORS headers to all responses."""

    async def dispatch(self, request, call_next):
        # Handle OPTIONS requests
        if request.method == "OPTIONS":
            return JSONResponse(
                {"ok": True},
                headers={
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                    "Access-Control-Allow-Headers": "*",
                    "Access-Control-Max-Age": "86400",
                }
            )

        response = await call_next(request)

        # Add CORS headers to response
        response.headers["Access-Control-Allow-Origin"] = "*"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = "*"

        return response


# ---------------------------------------------------------------------------
# Main Application
# ---------------------------------------------------------------------------

def create_app():
    """Create the MCP Starlette application with WebSocket and API routes."""
    mcp_app = mcp.streamable_http_app()

    # Add WebSocket route and API routes
    extra_routes = [
        WebSocketRoute('/ws', endpoint=handle_websocket),
        Route('/api/workspaces', endpoint=handle_list_workspaces, methods=['GET']),
        Route('/workspaces', endpoint=handle_list_workspaces, methods=['GET']),
        Route('/api/health', endpoint=handle_health, methods=['GET']),
        Route('/health', endpoint=handle_health, methods=['GET']),
    ]
    mcp_app.routes.extend(extra_routes)

    # Add CORS middleware for browser extension compatibility
    mcp_app.add_middleware(CORSSupportMiddleware)

    return mcp_app


def main():
    """Main entry point for the VS Code MCP Server."""
    import argparse

    parser = argparse.ArgumentParser(description="VS Code MCP Server")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="Port to listen on")
    parser.add_argument("--host", type=str, default="0.0.0.0", help="Host to bind to")
    args = parser.parse_args()

    log.info("Starting VS Code MCP Server on %s:%d", args.host, args.port)
    log.info("MCP endpoint: http://%s:%d/mcp", args.host, args.port)
    log.info("WebSocket endpoint: ws://%s:%d/ws", args.host, args.port)

    # Run server
    config = uvicorn.Config(create_app(), host=args.host, port=args.port, log_level="info")
    server = uvicorn.Server(config)

    asyncio.run(server.serve())


if __name__ == "__main__":
    main()
