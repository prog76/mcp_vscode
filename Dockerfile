# vscode-mcp-agent — router + standalone vscode agent + git-mcp-server.
#
# Built & pushed to ghcr.io/prog76/vscode-mcp-agent by .github/workflows/docker.yml
# on every v* tag (also `latest` on main).
#
# What runs in the container is now an mcp-router:
#   MCP client ──HTTP /mcp──▶ router
#                              ├─ "agent" embedded backend (this process' toolset, session = --session-id)
#                              ├─ "git"   stdio backend (git-mcp-server, spawned per session)
#                              └─ "windows" ws intake at /ws (remote VS Code windows dial in)
#
# Router:  docker run --rm -p 27681:27681 -v "$HOME/src:/workspace" \
#            ghcr.io/prog76/vscode-mcp-agent
#          (default CMD: --mode server --host 0.0.0.0 --config /app/router.yaml)
# Client:  docker run --rm \
#            ghcr.io/prog76/vscode-mcp-agent --mode client --hub ws://<router>:27681
# Stdio:   mcp-router (or any MCP host) can also spawn the agent's toolset directly:
#            docker run --rm -i ghcr.io/prog76/vscode-mcp-agent --mode stdio
#
# Ships an AI CLI toolset (zg, rg, sg, ripsed, jq, git) so the
# terminal_create/execute tools are actually useful inside the container.

# ---------------------------------------------------------------------------
# Build stage: compile shared + agent TypeScript, install node deps.
# Mirrors scripts/prepare.sh (nested npm installs need a clean env, which a
# pristine build container already provides).
# ---------------------------------------------------------------------------
FROM node:22-slim AS build

# node-pty builds a native module -> needs a C toolchain and python.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY shared/ shared/
COPY agent/ agent/
# Required by agent/package.json: "mcp-router": "file:../vendor/mcp-router-<v>.tgz"
COPY vendor/ vendor/

RUN npm install --prefix shared --no-audit --no-fund --silent \
 && npm install --prefix agent --no-audit --no-fund --silent \
 && ./agent/node_modules/.bin/tsc -p agent/tsconfig.json \
 && node --check agent/out/agent/src/main.js \
 && node --check agent/out/agent/src/stdio.js

# ---------------------------------------------------------------------------
# Toolchain stage: build ripsed (Rust stream editor) from crates.io.
# Same base image as runtime -> glibc-compatible binary; only the ~3MB
# binary is copied down, the Rust toolchain stays in this throwaway layer.
# ---------------------------------------------------------------------------
FROM node:22-slim AS toolchain

ARG RIP_SED_VERSION=0.3.2

RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL https://sh.rustup.rs -o /tmp/rustup.sh \
 && sh /tmp/rustup.sh -y --profile=minimal \
 && /root/.cargo/bin/cargo install ripsed-cli@${RIP_SED_VERSION}

# ---------------------------------------------------------------------------
# Runtime stage: agent + AI CLI toolset.
# Runs as root on purpose: ~/src is bind-mounted from the host and is owned by
# an arbitrary host uid (AD user) — a fixed non-root uid could not write to it.
# Restrict with compose `user:` overrides if your layout allows.
#
# `git config --system --add safe.directory '*'` below is the same trade-off:
# text at a bind mount is owned by a foreign uid, and git refuses to work on a
# repo it does not own. The mount IS the sandbox, so it is trusted wholesale.
# ---------------------------------------------------------------------------
FROM node:22-slim

ARG TARGETARCH
ARG AST_GREP_VERSION=0.45.3
ARG ZG_VERSION=0.2.2
ARG DOCKER_CLI_VERSION=28.3.2
ARG COMPOSE_VERSION=5.5.1
# git MCP upstream: spawned by the router as a per-session stdio backend
# (see deploy/router.yaml). Pinned so image builds are reproducible.
ARG GIT_MCP_VERSION=2.15.3

# Agent-facing toolset:
#   ripgrep   (rg)  fast regex search
#   zvec-grep (zg)  hybrid semantic + lexical search (index / query / server)
#   ast-grep  (sg)  structural/AST search & rewrite
#   ripsed          safe bulk find-replace/delete (sed-style, agent-native JSON)
#   docker + compose   host docker daemon control (socket bind-mounted in compose)
#   jq / git / curl / less / procps / openssh-client
# Human-only interactive tools (fzf, bat, fd-find) and repgrep (rgr) are
# deliberately NOT installed — the agent equivalents are zg / rg / sg / ripsed.
RUN case "${TARGETARCH}" in \
      arm64) SG_ARCH=aarch64; DOCKER_ARCH=aarch64; COMPOSE_ARCH=aarch64 ;; \
      *)     SG_ARCH=x86_64;  DOCKER_ARCH=x86_64;  COMPOSE_ARCH=x86_64  ;; \
    esac \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq unzip ripgrep less procps openssh-client \
 && rm -rf /var/lib/apt/lists/* \
 && git config --system --add safe.directory '*' \
 && curl -fsSL "https://github.com/ast-grep/ast-grep/releases/download/${AST_GREP_VERSION}/app-${SG_ARCH}-unknown-linux-gnu.zip" -o /tmp/sg.zip \
 && unzip -q /tmp/sg.zip -d /tmp/sg \
 && mv /tmp/sg/ast-grep /usr/local/bin/ast-grep \
 && ln -sf /usr/local/bin/ast-grep /usr/local/bin/sg \
 && rm -rf /tmp/sg.zip /tmp/sg \
 && curl -fsSL "https://download.docker.com/linux/static/stable/${DOCKER_ARCH}/docker-${DOCKER_CLI_VERSION}.tgz" -o /tmp/docker.tgz \
 && tar -xzf /tmp/docker.tgz -C /tmp docker/docker \
 && mv /tmp/docker/docker /usr/local/bin/docker \
 && rm -rf /tmp/docker.tgz /tmp/docker \
 && mkdir -p /usr/local/lib/docker/cli-plugins \
 && curl -fsSL "https://github.com/docker/compose/releases/download/v${COMPOSE_VERSION}/docker-compose-linux-${COMPOSE_ARCH}" -o /usr/local/lib/docker/cli-plugins/docker-compose \
 && chmod +x /usr/local/lib/docker/cli-plugins/docker-compose \
 && npm install -g --no-audit --no-fund @zvec/zvec-grep@${ZG_VERSION} @cyanheads/git-mcp-server@${GIT_MCP_VERSION} \
 && rm -rf /root/.npm

WORKDIR /app
COPY --from=build /build/agent/out           ./agent/out
COPY --from=build /build/agent/node_modules  ./agent/node_modules
COPY --from=build /build/agent/package.json  ./agent/package.json
COPY --from=build /build/shared/node_modules ./shared/node_modules
COPY --from=build /build/shared/package.json ./shared/package.json
COPY --from=toolchain /root/.cargo/bin/ripsed /usr/local/bin/ripsed

# Verify the agent toolset, the git MCP upstream, and that the human-only
# tools are really gone.
RUN set -e; \
    rg --version | head -1; \
    zg --version | head -1; \
    ast-grep --version | head -1; \
    sg --version | head -1; \
    ripsed --version | head -1; \
    docker --version | head -1; \
    docker compose version | head -1; \
    ! command -v fzf >/dev/null 2>&1 \
 && ! command -v fdfind >/dev/null 2>&1 && ! command -v fd >/dev/null 2>&1 \
 && ! command -v bat >/dev/null 2>&1 && ! command -v batcat >/dev/null 2>&1 \
 && ! command -v rgr >/dev/null 2>&1 \
 && command -v git-mcp-server >/dev/null 2>&1 \
 && test -f "$(npm root -g)/@cyanheads/git-mcp-server/dist/index.js"

# Stateful tool state (zg runtime/config/daemon) - compose mounts the\
# named volume agent-state: here so it survives container recreation.
ENV ZVEC_GREP_HOME=/var/lib/agent-state/zvec-grep
# Local offline embedding model for the watcher daemon (no API key needed).
ENV ZVEC_GREP_EMBEDDING=local/potion-code-16m-v2
RUN mkdir -p /var/lib/agent-state/zvec-grep
# Default cwd for terminal_create/execute (compose mounts ~/src here).
WORKDIR /workspace
ENV SHELL=/bin/bash
EXPOSE 27681

COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh
COPY docker-healthcheck.sh /docker-healthcheck.sh
RUN chmod +x /docker-healthcheck.sh
# Router config: wires the git upstream as a per-session stdio backend.
# `--mode server` adds this agent's own toolset as the embedded "agent"
# backend and the ws intake for remote VS Code windows.
COPY deploy/router.yaml /app/router.yaml

# Mode-aware: curl local /health when serving as the router, verify the agent
# process is alive when running as a satellite (--hub), which never listens.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD /docker-healthcheck.sh

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["--mode", "server", "--host", "0.0.0.0", "--config", "/app/router.yaml"]
