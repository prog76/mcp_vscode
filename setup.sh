#!/bin/bash
# VS Code MCP - Full Environment Setup Script
# This script sets up the complete development environment

set -e

echo "=== VS Code MCP Environment Setup ==="
echo ""

# Check if we're in the project directory
if [ ! -f "Makefile" ]; then
    echo "Error: Please run this script from the project root directory"
    exit 1
fi

# Install extension dependencies
echo "1. Installing extension dependencies..."
cd extension && npm install && cd ..

# Install Python dependencies
echo "2. Installing Python dependencies..."
pip3 install --break-system-packages . 2>/dev/null || pip install .

# Build the extension
echo "3. Building extension..."
make build

# Install the extension
echo "4. Installing extension to VS Code..."
make install-extension

# Check if server is already running
if lsof -i :9876 >/dev/null 2>&1; then
    echo "5. MCP server already running on port 9876"
else
    echo "5. Starting MCP server..."
    make start-server
fi

echo ""
echo "=== Setup Complete ==="
echo "MCP Server: http://localhost:9876"
echo "MCP Endpoint: http://localhost:9876/mcp"
echo "Health Check: http://localhost:9876/health"
echo "Workspaces: http://localhost:9876/workspaces"
echo ""
echo "To use the extension in VS Code:"
echo "  1. Open a workspace in VS Code"
echo "  2. The extension will auto-register on startup (onStartupFinished)"
echo "  3. Use 'Show VS Code MCP Status' command to verify"
echo ""
echo "Available make commands:"
echo "  make dev           - Full development setup"
echo "  make build         - Build extension"
echo "  make install-ext   - Install extension to VS Code"
echo "  make start-server  - Start MCP server"
echo "  make stop-server   - Stop MCP server"
echo "  make restart-server - Restart MCP server"
echo "  make
