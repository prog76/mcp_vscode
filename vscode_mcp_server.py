#!/usr/bin/env python3
"""
VS Code MCP Server - Compatibility shim for direct script execution.

This file redirects to the vscode_mcp package.
For pip installation, use: pip install .
Then run: vscode-mcp-server or python -m vscode_mcp
"""

from vscode_mcp.server import main

if __name__ == "__main__":
    main()
