.PHONY: help install build build-with-version install-extension start-server stop-server restart-server dev clean

help: ## Show this help message
	@echo "VS Code MCP Extension - Available targets:"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

#doesn't work
# install: ## Install all dependencies (npm and Python), build, install VSIX, and reload extension host
# 	@echo "Building and installing extension..."
# 	@$(MAKE) build
# 	@vsix=$$(ls -t extension/*.vsix | head -1); \
# 		echo "Installing $$vsix..."; \
# 		code --force --install-extension "$$vsix" 2>&1; \
# 		echo "Reloading extension host..."; \
# 		pkill -f "bootstrap-fork.*--type=extensionHost"

build: ## Build with auto-incremented version (patch)
	@echo "Auto-incrementing version..."
	@cd extension && npm version patch --no-git-tag-version
	@cd extension && npm run compile
	@cd extension && npx vsce package --allow-missing-repository --no-yarn
	@echo "VSIX package created: extension/*.vsix"
	@echo "New version: $$(cd extension && node -p 'require("./package.json").version')"

clean: ## Clean build artifacts
	@echo "Cleaning build artifacts..."
	rm -f extension/*.vsix
	rm -rf extension/out
	rm -f server.log server.pid
	@echo "Clean complete"

.DEFAULT_GOAL := help