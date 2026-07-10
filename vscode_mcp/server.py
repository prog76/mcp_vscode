#!/usr/bin/env python3
"""
VS Code MCP Server - Central server that routes MCP tool calls to VS Code extensions.

Architecture:
- Single MCP endpoint at /mcp
- All tools take 'workspace' as first argument
- VS Code extensions register themselves per workspace
- Server routes tool calls to the correct extension

Usage:
    python -m vscode_mcp                    # Run on default port 9876
    python -m vscode_mcp --port 9999         # Custom port
    vscode-mcp-server --port 9999             # After pip install
"""

import asyncio
import json
import logging
import time
import uuid
from typing import Any, Dict, Optional
from datetime import datetime, timedelta

import httpx
import uvicorn
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Mount, Route

from mcp.server.fastmcp import FastMCP

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
log = logging.getLogger("vscode-mcp")

# Configuration
DEFAULT_PORT = 9876
HEARTBEAT_TIMEOUT = 90  # seconds - remove extension if no heartbeat for this long
HEARTBEAT_INTERVAL = 30  # seconds - extension should send heartbeat this often

# Global state
extensions: Dict[str, Dict[str, Any]] = {}  # workspace_name -> {url, last_heartbeat, metadata}


# ---------------------------------------------------------------------------
# Extension Registry
# ---------------------------------------------------------------------------

def get_extension(workspace: str) -> Optional[Dict[str, Any]]:
    """Get registered extension for workspace, or None if not found/expired."""
    # Try exact match first
    ext = extensions.get(workspace)

    # If not found, try to match by workspace name prefix (for dev containers)
    if not ext:
        for ws, ext_data in extensions.items():
            # Check if workspace name starts with the given workspace
            if ws.startswith(workspace) or workspace in ws:
                ext = ext_data
                log.debug("Matched workspace '%s' to registered '%s'", workspace, ws)
                break

    if not ext:
        return None

    # Check if heartbeat is recent
    if time.time() - ext['last_heartbeat'] > HEARTBEAT_TIMEOUT:
        log.warning("Extension for workspace '%s' expired (no heartbeat)", workspace)
        del extensions[workspace]
        return None

    return ext


def cleanup_expired_extensions():
    """Remove extensions that haven't sent heartbeat recently."""
    now = time.time()
    expired = [
        ws for ws, ext in extensions.items()
        if now - ext['last_heartbeat'] > HEARTBEAT_TIMEOUT
    ]
    for ws in expired:
        log.info("Removing expired extension for workspace: %s", ws)
        del extensions[ws]


async def call_extension(workspace: str, tool: str, arguments: Dict[str, Any]) -> str:
    """Forward tool call to VS Code extension."""
    ext = get_extension(workspace)
    if not ext:
        return f"Error: No VS Code instance registered for workspace '{workspace}'. Start VS Code with the vscode-mcp extension activated."

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                f"{ext['url']}/execute",
                json={"tool": tool, "arguments": arguments}
            )
            response.raise_for_status()
            data = response.json()
            return data.get('result', 'Error: No result in response')
    except httpx.TimeoutException:
        return f"Error: Timeout calling extension for workspace '{workspace}'"
    except Exception as e:
        log.error("Error calling extension for workspace '%s': %s", workspace, e)
        return f"Error: {str(e)}"


# ---------------------------------------------------------------------------
# MCP Server Tools
# ---------------------------------------------------------------------------

from mcp.server.transport_security import TransportSecuritySettings

# Disable DNS rebinding protection for browser extension compatibility
transport_security = TransportSecuritySettings(enable_dns_rebinding_protection=False)
mcp = FastMCP("vscode-mcp", transport_security=transport_security, stateless_http=True)


@mcp.tool(structured_output=False)
async def terminal_create(workspace: str, name: str, cwd: str = "") -> str:
    """Create a new terminal in the specified VS Code workspace."""
    log.info("Creating terminal in workspace '%s': %s", workspace, name)
    return await call_extension(workspace, 'terminal_create', {
        'name': name,
        'cwd': cwd
    })


@mcp.tool(structured_output=False)
async def terminal_exec(workspace: str, terminal_id: str, command: str) -> str:
    """Execute a command in a terminal."""
    log.info("Executing in workspace '%s' terminal %s: %s", workspace, terminal_id, command)
    return await call_extension(workspace, 'terminal_exec', {
        'terminal_id': terminal_id,
        'command': command
    })


@mcp.tool(structured_output=False)
async def terminal_read(workspace: str, terminal_id: str, since_index: int = 0) -> str:
    """Read terminal output since last read."""
    log.debug("Reading terminal output from workspace '%s' terminal %s since %d",
              workspace, terminal_id, since_index)
    return await call_extension(workspace, 'terminal_read', {
        'terminal_id': terminal_id,
        'since_index': since_index
    })


@mcp.tool(structured_output=False)
async def terminal_list(workspace: str) -> str:
    """List all active terminals in a workspace."""
    log.debug("Listing terminals in workspace '%s'", workspace)
    return await call_extension(workspace, 'terminal_list', {})


@mcp.tool(structured_output=False)
async def terminal_kill(workspace: str, terminal_id: str) -> str:
    """Kill a terminal."""
    log.info("Killing terminal %s in workspace '%s'", terminal_id, workspace)
    return await call_extension(workspace, 'terminal_kill', {
        'terminal_id': terminal_id
    })


# ---------------------------------------------------------------------------
# HTTP Endpoints for Extensions
# ---------------------------------------------------------------------------

async def handle_register(request: Request):
    """Handle extension registration."""
    try:
        data = await request.json()
        workspace = data.get('workspace')
        extension_url = data.get('extension_url')

        if not workspace or not extension_url:
            return JSONResponse(
                {"error": "Missing required fields: workspace, extension_url"},
                status_code=400
            )

        extensions[workspace] = {
            'url': extension_url,
            'last_heartbeat': time.time(),
            'registered_at': time.time(),
            'metadata': data.get('metadata', {})
        }

        log.info("Registered extension for workspace: %s at %s", workspace, extension_url)

        return JSONResponse({
            "status": "registered",
            "workspace": workspace,
            "endpoint": f"/mcp"
        })
    except Exception as e:
        log.error("Registration error: %s", e)
        return JSONResponse({"error": str(e)}, status_code=400)


async def handle_heartbeat(request: Request):
    """Handle extension heartbeat."""
    try:
        data = await request.json()
        workspace = data.get('workspace')

        if not workspace:
            return JSONResponse({"error": "Missing workspace"}, status_code=400)

        # Try exact match first, then try to match by workspace name prefix
        matched_workspace = None
        if workspace in extensions:
            matched_workspace = workspace
        else:
            for ws in extensions.keys():
                if ws.startswith(workspace) or workspace in ws:
                    matched_workspace = ws
                    break

        if matched_workspace:
            extensions[matched_workspace]['last_heartbeat'] = time.time()
            log.debug("Heartbeat from workspace: %s", matched_workspace)
            return JSONResponse({"status": "ok"})
        else:
            return JSONResponse(
                {"error": f"Workspace '{workspace}' not registered"},
                status_code=404
            )
    except Exception as e:
        log.error("Heartbeat error: %s", e)
        return JSONResponse({"error": str(e)}, status_code=400)


async def handle_list_workspaces(request: Request):
    """List all registered workspaces."""
    cleanup_expired_extensions()

    workspaces = []
    for ws, ext in extensions.items():
        age = time.time() - ext['last_heartbeat']
        workspaces.append({
            "name": ws,
            "url": ext['url'],
            "last_heartbeat_seconds_ago": round(age, 1),
            "registered_at": datetime.fromtimestamp(ext['registered_at']).isoformat()
        })

    return JSONResponse({"workspaces": workspaces})


async def handle_health(request: Request):
    """Health check endpoint."""
    cleanup_expired_extensions()
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
# Background Tasks
# ---------------------------------------------------------------------------

async def cleanup_task():
    """Periodically clean up expired extensions."""
    while True:
        await asyncio.sleep(60)  # Every minute
        cleanup_expired_extensions()


# ---------------------------------------------------------------------------
# Main Application
# ---------------------------------------------------------------------------

def create_app():
    """Create the MCP Starlette application with API routes and CORS support."""
    # streamable_http_app() returns a Starlette app with:
    # - Route at /mcp (POST) for MCP requests
    # - stateless HTTP (no session management)
    mcp_app = mcp.streamable_http_app()

    # Add API routes (both /api/* and /* for compatibility)
    api_routes = [
        Route('/api/register', endpoint=handle_register, methods=['POST']),
        Route('/register', endpoint=handle_register, methods=['POST']),
        Route('/api/heartbeat', endpoint=handle_heartbeat, methods=['POST']),
        Route('/heartbeat', endpoint=handle_heartbeat, methods=['POST']),
        Route('/api/workspaces', endpoint=handle_list_workspaces, methods=['GET']),
        Route('/workspaces', endpoint=handle_list_workspaces, methods=['GET']),
        Route('/api/health', endpoint=handle_health, methods=['GET']),
        Route('/health', endpoint=handle_health, methods=['GET']),
    ]
    mcp_app.routes.extend(api_routes)

    # Add CORS middleware for browser extension compatibility
    mcp_app.add_middleware(CORSSupportMiddleware)

    return mcp_app


def main():
    """Main entry point for the VS Code MCP Server."""
    import argparse

    parser = argparse.ArgumentParser(description="VS Code MCP Server")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="Port to listen on")
    parser.add_argument("--host", type=str, default="localhost", help="Host to bind to")
    args = parser.parse_args()

    log.info("Starting VS Code MCP Server on %s:%d", args.host, args.port)
    log.info("MCP endpoint: http://%s:%d/mcp", args.host, args.port)
    log.info("Registration endpoint: http://%s:%d/register", args.host, args.port)

    # Run server
    config = uvicorn.Config(create_app(), host=args.host, port=args.port, log_level="info")
    server = uvicorn.Server(config)

    # Start cleanup task in background
    async def run_server():
        cleanup = asyncio.create_task(cleanup_task())
        try:
            await server.serve()
        finally:
            cleanup.cancel()
            try:
                await cleanup
            except asyncio.CancelledError:
                pass

    asyncio.run(run_server())


if __name__ == "__main__":
    main()
