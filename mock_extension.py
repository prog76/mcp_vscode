#!/usr/bin/env python3
"""
Mock VS Code extension for testing the MCP server.

Simulates a VS Code extension without needing actual VS Code.
Useful for testing the central server and agent integration.
"""

import asyncio
import json
import logging
from typing import Any, Dict

import httpx
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route
import uvicorn

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
log = logging.getLogger("mock-extension")

# Configuration
WORKSPACE = "test-project"
PORT = 9999
SERVER_URL = "http://localhost:9876"

# Simulated terminal state
terminals: Dict[str, Dict[str, Any]] = {}


class MockTerminal:
    """Simulates a VS Code terminal."""

    def __init__(self, name: str, cwd: str):
        self.name = name
        self.cwd = cwd
        self.output_buffer = []
        self.process_id = id(self)

    def send_text(self, text: str):
        """Simulate sending text to terminal."""
        self.output_buffer.append(f"$ {text}\n")
        # Simulate command output
        if text.startswith("ls"):
            self.output_buffer.append("file1.txt  file2.txt  folder/\n")
        elif text.startswith("echo"):
            self.output_buffer.append(text[5:] + "\n")
        elif text.startswith("pwd"):
            self.output_buffer.append(f"{self.cwd}\n")
        elif text.startswith("whoami"):
            self.output_buffer.append("testuser\n")
        else:
            self.output_buffer.append(f"Executed: {text}\n")


# Create mock terminals
mock_terminals = {
    "term_123": MockTerminal("Test Terminal", "/workspace/test-project"),
    "term_456": MockTerminal("Build Terminal", "/workspace/test-project"),
}


async def handle_execute(request: Request):
    """Handle tool execution requests."""
    try:
        data = await request.json()
        tool = data.get('tool')
        args = data.get('arguments', {})

        log.info(f"Executing tool: {tool} with args: {args}")

        result = None

        if tool == 'terminal_create':
            name = args.get('name', 'Mock Terminal')
            cwd = args.get('cwd', '/workspace/test-project')
            term_id = f"term_{len(mock_terminals) + 1}"
            mock_terminals[term_id] = MockTerminal(name, cwd)
            result = term_id

        elif tool == 'terminal_exec':
            term_id = args.get('terminal_id')
            command = args.get('command')
            if term_id in mock_terminals:
                mock_terminals[term_id].send_text(command)
                result = 'Executed'
            else:
                result = 'Error: Terminal not found'

        elif tool == 'terminal_read':
            term_id = args.get('terminal_id')
            since_index = args.get('since_index', 0)
            if term_id in mock_terminals:
                term = mock_terminals[term_id]
                output = ''.join(term.output_buffer[since_index:])
                result = {
                    'output': output,
                    'next_index': len(term.output_buffer)
                }
            else:
                result = {'output': '', 'next_index': 0}

        elif tool == 'terminal_list':
            result = [
                {
                    'id': tid,
                    'name': t.name,
                    'cwd': t.cwd
                }
                for tid, t in mock_terminals.items()
            ]

        elif tool == 'terminal_kill':
            term_id = args.get('terminal_id')
            if term_id in mock_terminals:
                del mock_terminals[term_id]
                result = 'Killed'
            else:
                result = 'Error: Terminal not found'

        else:
            result = f"Error: Unknown tool: {tool}"

        log.info(f"Result: {result}")
        return JSONResponse({'result': result})

    except Exception as e:
        log.error(f"Error executing tool: {e}")
        return JSONResponse({'result': f"Error: {e}"})


async def send_heartbeat():
    """Send heartbeat to central server."""
    while True:
        try:
            await asyncio.sleep(30)  # Every 30 seconds
            async with httpx.AsyncClient() as client:
                response = await client.post(f"{SERVER_URL}/heartbeat", json={
                    'workspace': WORKSPACE
                })
                if response.status_code == 200:
                    log.debug("Heartbeat sent")
                else:
                    log.warning(f"Heartbeat failed: {response.status_code}")
        except Exception as e:
            log.error(f"Heartbeat error: {e}")


async def register_with_server():
    """Register this extension with the central server."""
    await asyncio.sleep(2)  # Wait for server to be ready

    extension_url = f"http://localhost:{PORT}"
    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(f"{SERVER_URL}/register", json={
                'workspace': WORKSPACE,
                'extension_url': extension_url
            })
            if response.status_code == 200:
                log.info(f"Registered with central server: {response.json()}")
            else:
                log.error(f"Registration failed: {response.status_code}")
    except Exception as e:
        log.error(f"Registration error: {e}")


def create_app():
    """Create the Starlette application."""
    app = Starlette(routes=[
        Route('/execute', endpoint=handle_execute, methods=['POST']),
    ])

    return app


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Mock VS Code Extension")
    parser.add_argument("--workspace", type=str, default=WORKSPACE, help="Workspace name")
    parser.add_argument("--port", type=int, default=PORT, help="Port to listen on")
    parser.add_argument("--server", type=str, default=SERVER_URL, help="Central server URL")
    args = parser.parse_args()

    WORKSPACE = args.workspace
    PORT = args.port
    SERVER_URL = args.server

    log.info(f"Starting mock extension for workspace: {WORKSPACE}")
    log.info(f"Listening on port: {PORT}")
    log.info(f"Central server: {SERVER_URL}")

    # Run server with startup tasks
    config = uvicorn.Config(create_app(), host='localhost', port=PORT, log_level="info")
    server = uvicorn.Server(config)

    async def run_server():
        # Start background tasks
        asyncio.create_task(register_with_server())
        asyncio.create_task(send_heartbeat())
        log.info(f"Mock extension started on port {PORT}")
        await server.serve()

    asyncio.run(run_server())
