.PHONY: help install build build-agent install-extension start-server stop-server restart-server dev clean

help: ## Show this help message
	@echo "VS Code MCP - Available targets:"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

#doesn't work
install: ## Install all dependencies, build, install VSIX, and reload extension host
	@echo "Building and installing extension..."
	@$(MAKE) build
	@vsix=$$(ls -t extension/*.vsix | head -1); \
		echo "Installing $$vsix..."; \
		code --force --install-extension "$$vsix" 2>&1; \
		echo "Reloading extension host..."; \
		pkill -f "bootstrap-fork.*--type=extensionHost"

build: ## Build extension (VSIX, version bump) AND agent together
	@echo "=== Building extension ==="
	@cd extension && npm version patch --no-git-tag-version
	@cd extension && npm run compile
	@cd extension && npx vsce package --allow-missing-repository --no-yarn
	@echo "VSIX package created: extension/*.vsix"
	@echo "New version: $$(cd extension && node -p 'require("./package.json").version')"
	@echo ""
	@echo "=== Building agent ==="
	@$(MAKE) build-agent

build-agent: ## Build only the standalone agent (no VSIX, no version bump)
	@cd shared && npm install --silent
	@cd agent && npm install --silent
	@cd agent && npx tsc -p tsconfig.json
	@echo "Agent built: agent/out/agent/src/main.js"

clean: ## Clean build artifacts
	@echo "Cleaning build artifacts..."
	rm -f extension/*.vsix
	rm -rf extension/out agent/out
	rm -f server.log server.pid
	@echo "Clean complete"

.DEFAULT_GOAL := help
