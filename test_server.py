#!/usr/bin/env python3
"""
Test script for VS Code MCP Server.

Tests the central server without needing the actual VS Code extension.
Simulates extension registration and tool calls.
"""

import asyncio
import json
import time
import httpx


async def test_server():
    """Test the VS Code MCP server."""
    base_url = "http://localhost:9876"

    print("Testing VS Code MCP Server")
    print("=" * 60)

    async with httpx.AsyncClient() as client:
        # Test 1: Health check
        print("\n1. Testing health endpoint...")
        try:
            response = await client.get(f"{base_url}/api/health")
            print(f"   Status: {response.status_code}")
            print(f"   Response: {json.dumps(response.json(), indent=2)}")
        except Exception as e:
            print(f"   ERROR: {e}")
            print("   Make sure server is running: python vscode_mcp_server.py")
            return

        # Test 2: Register mock extension
        print("\n2. Testing extension registration...")
        try:
            response = await client.post(f"{base_url}/api/register", json={
                "workspace": "test-project",
                "extension_url": "http://localhost:9999"
            })
            print(f"   Status: {response.status_code}")
            print(f"   Response: {json.dumps(response.json(), indent=2)}")
        except Exception as e:
            print(f"   ERROR: {e}")
            return

        # Test 3: List workspaces
        print("\n3. Testing workspace list...")
        try:
            response = await client.get(f"{base_url}/api/workspaces")
            print(f"   Status: {response.status_code}")
            print(f"   Response: {json.dumps(response.json(), indent=2)}")
        except Exception as e:
            print(f"   ERROR: {e}")
            return

        # Test 4: Send heartbeat
        print("\n4. Testing heartbeat...")
        try:
            response = await client.post(f"{base_url}/api/heartbeat", json={
                "workspace": "test-project"
            })
            print(f"   Status: {response.status_code}")
            print(f"   Response: {json.dumps(response.json(), indent=2)}")
        except Exception as e:
            print(f"   ERROR: {e}")
            return

        # Test 5: Try MCP tool call (will fail - no real extension)
        print("\n5. Testing MCP tool call (expected to fail)...")
        try:
            response = await client.post(f"{base_url}/mcp", json={
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {
                    "name": "terminal_create",
                    "arguments": {
                        "workspace": "test-project",
                        "name": "Test Terminal"
                    }
                }
            })
            print(f"   Status: {response.status_code}")
            print(f"   Response: {json.dumps(response.json(), indent=2)}")
        except Exception as e:
            print(f"   ERROR: {e}")

        # Test 6: Register second workspace
        print("\n6. Testing second workspace registration...")
        try:
            response = await client.post(f"{base_url}/api/register", json={
                "workspace": "another-project",
                "extension_url": "http://localhost:9998"
            })
            print(f"   Status: {response.status_code}")
            print(f"   Response: {json.dumps(response.json(), indent=2)}")
        except Exception as e:
            print(f"   ERROR: {e}")

        # Test 7: List workspaces again
        print("\n7. Testing workspace list (should have 2)...")
        try:
            response = await client.get(f"{base_url}/api/workspaces")
            print(f"   Status: {response.status_code}")
            data = response.json()
            print(f"   Workspaces: {len(data['workspaces'])}")
            for ws in data['workspaces']:
                print(f"     - {ws['name']} ({ws['url']})")
        except Exception as e:
            print(f"   ERROR: {e}")

    print("\n" + "=" * 60)
    print("Test complete!")


if __name__ == "__main__":
    asyncio.run(test_server())
