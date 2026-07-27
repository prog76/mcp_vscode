#!/usr/bin/env python3
"""
Mock VS Code extension for testing the MCP server.
Uses WebSocket to connect to the server, simulating the new WS architecture.

Usage:
    python mock_extension.py --workspace test-project --port 9999 --server http://localhost:9876
"""

import asyncio
import json
import logging
import uuid
from typing import Any, Dict, Optional

import httpx
from starlette.applications import Starlette
from starlette.websockets import WebSocket, WebSocketDisconnect
import uvicorn

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
log = logging.getLogger("mock-extension")

# Configuration
WORKSPACE = "test-project"
SERVER_URL = "http://localhost:9876"

# Simulated terminal state
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


mock_terminals: Dict[str, MockTerminal] = {}


async def handle_execute(tool: str, args: dict) -> str:
    """Execute a tool and return the result."""
    log.info(f"Executing tool: {tool} with args: {args}")

    if tool == 'terminal_create':
        name = args.get('name', 'Mock Terminal')
        cwd = args.get('cwd', '/workspace/test-project')
        term_id = f"term_{len(mock_terminals) + 1}"
        mock_terminals[term_id] = MockTerminal(name, cwd)
        return term_id

    elif tool == 'terminal_exec':
        term_id = args.get('terminal_id')
        command = args.get('command')
        if term_id in mock_terminals:
            mock_terminals[term_id].send_text(command)
            return 'Executed'
        else:
            return 'Error: Terminal not found'

    elif tool == 'terminal_read':
        term_id = args.get('terminal_id')
        since_index = args.get('since_index', 0)
        if term_id in mock_terminals:
            term = mock_terminals[term_id]
            output = ''.join(term.output_buffer[since_index:])
            return json.dumps({
                'output': output,
                'next_index': len(term.output_buffer)
            })
        else:
            return json.dumps({'output': '', 'next_index': 0})

    elif tool == 'terminal_list':
        result = [
            {
                'id': tid,
                'name': t.name,
                'cwd': t.cwd
            }
            for tid, t in mock_terminals.items()
        ]
        return json.dumps(result)

    elif tool == 'terminal_kill':
        term_id = args.get('terminal_id')
        if term_id in mock_terminals:
            del mock_terminals[term_id]
            return 'Killed'
        else:
            return 'Error: Terminal not found'

    else:
        return f"Error: Unknown tool: {tool}"


async def websocket_client(server_url: str, workspace: str):
    """Connect to the server via WebSocket and handle tool execution requests."""
    ws_url = server_url.replace("http://", "ws://").rstrip("/") + "/ws"
    log.info(f"Connecting to WebSocket: {ws_url}")

    while True:  # Reconnection loop
        try:
            async with httpx.AsyncClient() as client:
                # Starlette's WebSocket test client is complex to use directly,
                # so we connect via HTTP upgrade using httpx for real WS support
                pass

            # Use websockets library for proper WebSocket client
            import websockets
            async with websockets.connect(ws_url) as websocket:
                log.info("WebSocket connected")

                # Register workspace
                await websocket.send(json.dumps({
                    "type": "register",
                    "workspace": workspace,
                }))
                log.info(f"Sent registration for workspace: {workspace}")

                # Listen for messages
                async for message in websocket:
                    data = json.loads(message)
                    msg_type = data.get("type")

                    if msg_type == "registered":
                        log.info(f"Registered workspace: {data.get('workspace')}")

                    elif msg_type == "execute":
                        request_id = data.get("requestId")
                        tool = data.get("tool")
                        args = data.get("arguments", {})

                        log.info(f"Received execute request: {tool} (id={request_id})")
                        result = await handle_execute(tool, args)

                        await websocket.send(json.dumps({
                            "type": "result",
                            "requestId": request_id,
                            "result": result,
                        }))
                        log.info(f"Sent result for {tool}: {result[:50]}...")

                    elif msg_type == "ping":
                        await websocket.send(json.dumps({"type": "pong"}))

                    elif msg_type == "error":
                        log.error(f"Server error: {data.get('message')}")

                    else:
                        log.debug(f"Unknown message type: {msg_type}")

        except websockets.exceptions.ConnectionClosed as e:
            log.warning(f"WebSocket disconnected: {e}. Reconnecting in 5s...")
            await asyncio.sleep(5)
        except Exception as e:
            log.error(f"WebSocket error: {e}. Reconnecting in 5s...")
            await asyncio.sleep(5)


async def main():
    import argparse

    parser = argparse.ArgumentParser(description="Mock VS Code Extension (WebSocket)")
    parser.add_argument("--workspace", type=str, default=WORKSPACE, help="Workspace name")
    parser.add_argument("--server", type=str, default=SERVER_URL, help="Central server URL")
    args = parser.parse_args()

    log.info(f"Starting mock extension for workspace: {args.workspace}")
    log.info(f"Connecting to server: {args.server}")

    await websocket_client(args.server, args.workspace)


if __name__ == "__main__":
    asyncio.run(main())