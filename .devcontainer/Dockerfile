FROM python:3.12-slim

# Install necessary tools and dependencies
RUN apt-get update && apt-get install -y \
    curl \
    jq \
    sudo \
    make \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20.x (required for vsce)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && \
    sudo apt-get install -y nodejs

# Install Python packages for MCP server
# Copy pyproject.toml and package source to install from project
COPY pyproject.toml vscode_mcp/ /tmp/
RUN pip install --break-system-packages /tmp

# Create non-root user (must be done before VS Code install for proper sandbox ownership)
RUN useradd -m -s /bin/bash vscode && \
    echo 'vscode ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers

# Install vsce (VS Code Extension Manager) for extension packaging
# This is the proper tool for extension development in headless environments
RUN npm install -g @vscode/vsce

# Create workspace directory (must match workspaceFolder in devcontainer.json)
RUN mkdir -p /vsc-mcp && chown -R vscode:vscode /vsc-mcp

USER vscode
WORKDIR /vsc-mcp
