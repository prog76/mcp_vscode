.PHONY: help install build build-with-version install-extension start-server stop-server restart-server dev clean

help: ## Show this help message
	@echo "VS Code MCP Extension - Available targets:"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

install: ## Install all dependencies (npm and Python)
	@echo "Installing extension dependencies..."
	cd extension && npm install
	@echo "Installing Python package..."
	pip3 install --break-system-packages . 2>/dev/null || pip install .

build: ## Build with auto-incremented version (patch)
	@echo "Auto-incrementing version..."
	@cd extension && npm version patch --no-git-tag-version
	@extver=$$(cd extension && node -p 'require("./package.json").version'); \
		sed -i "s/__version__ = \".*\"/__version__ = \"$$extver\"/" vscode_mcp/__init__.py; \
		echo "Python version updated to $$extver"
	@cd extension && npm run compile
	@cd extension && npx vsce package --allow-missing-repository --no-yarn
	@echo "VSIX package created: extension/*.vsix"
	@echo "New version: $$(cd extension && node -p 'require("./package.json").version')"

install-extension: build ## Create VSIX package (for devcontainer use)
	@echo "VSIX package created: extension/*.vsix"
	@echo "Note: In devcontainer, extension is installed via VS Code UI"

start-server: ## Start MCP server in background
	@echo "Starting MCP server on port 9876..."
	@if [ -f server.pid ]; then \
		echo "Server already running (PID: $$(cat server.pid))"; \
		exit 1; \
	fi
	@python3 vscode_mcp_server.py > server.log 2>&1 & echo $$! > server.pid
	@sleep 2
	@echo "Server started (PID: $$(cat server.pid))"
	@echo "Checking health..."
	@curl -s http://localhost:9876/api/health || echo "Server not ready yet"

stop-server: ## Stop MCP server
	@echo "Stopping MCP server..."
	@if [ -f server.pid ]; then \
		kill $$(cat server.pid) 2>/dev/null || true; \
		rm -f server.pid; \
		echo "Server stopped"; \
	else \
		echo "Server not running"; \
	fi

restart-server: stop-server start-server ## Restart MCP server

dev: build install-extension start-server ## Full development setup (build + install + start)

clean: ## Clean build artifacts
	@echo "Cleaning build artifacts..."
	rm -f extension/*.vsix
	rm -rf extension/out
	rm -f server.log server.pid
	@echo "Clean complete"

.DEFAULT_GOAL := help
