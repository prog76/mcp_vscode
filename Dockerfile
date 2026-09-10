# vscode-mcp-agent — standalone hub/satellite agent image.
#
# Built & pushed to ghcr.io/prog76/vscode-mcp-agent by .github/workflows/docker.yml
# on every v* tag (also `latest` on main).
#
# Server: docker run --rm -p 27681:27681 -v "$HOME/src:/workspace" \
#           ghcr.io/prog76/vscode-mcp-agent --mode server --host 0.0.0.0
# Client: docker run --rm \
#           ghcr.io/prog76/vscode-mcp-agent --mode client --hub ws://<hub>:27681
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

RUN npm install --prefix shared --no-audit --no-fund --silent \
 && npm install --prefix agent --no-audit --no-fund --silent \
 && ./agent/node_modules/.bin/tsc -p agent/tsconfig.json \
 && node --check agent/out/agent/src/main.js \
 && node --check agent/out/shared/src/hubServer.js

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
# ---------------------------------------------------------------------------
FROM node:22-slim

ARG TARGETARCH
ARG AST_GREP_VERSION=0.45.3
ARG ZG_VERSION=0.2.2
ARG DOCKER_CLI_VERSION=28.3.2

# Agent-facing toolset:
#   ripgrep   (rg)  fast regex search
#   zvec-grep (zg)  hybrid semantic + lexical search (index / query / server)
#   ast-grep  (sg)  structural/AST search & rewrite
#   ripsed          safe bulk find-replace/delete (sed-style, agent-native JSON)
#   docker           host docker daemon control (socket bind-mounted in compose)
#   jq / git / curl / less / procps
# Human-only interactive tools (fzf, bat, fd-find) and repgrep (rgr) are
# deliberately NOT installed — the agent equivalents are zg / rg / sg / ripsed.
RUN case "${TARGETARCH}" in \
      arm64) SG_ARCH=aarch64; DOCKER_ARCH=aarch64 ;; \
      *)     SG_ARCH=x86_64;  DOCKER_ARCH=x86_64  ;; \
    esac \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq unzip ripgrep less procps \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL "https://github.com/ast-grep/ast-grep/releases/download/${AST_GREP_VERSION}/app-${SG_ARCH}-unknown-linux-gnu.zip" -o /tmp/sg.zip \
 && unzip -q /tmp/sg.zip -d /tmp/sg \
 && mv /tmp/sg/ast-grep /usr/local/bin/ast-grep \
 && ln -sf /usr/local/bin/ast-grep /usr/local/bin/sg \
 && rm -rf /tmp/sg.zip /tmp/sg \
 && curl -fsSL "https://download.docker.com/linux/static/stable/${DOCKER_ARCH}/docker-${DOCKER_CLI_VERSION}.tgz" -o /tmp/docker.tgz \
 && tar -xzf /tmp/docker.tgz -C /tmp docker/docker \
 && mv /tmp/docker/docker /usr/local/bin/docker \
 && rm -rf /tmp/docker.tgz /tmp/docker \
 && npm install -g --no-audit --no-fund @zvec/zvec-grep@${ZG_VERSION} \
 && rm -rf /root/.npm

WORKDIR /app
COPY --from=build /build/agent/out           ./agent/out
COPY --from=build /build/agent/node_modules  ./agent/node_modules
COPY --from=build /build/agent/package.json  ./agent/package.json
COPY --from=build /build/shared/node_modules ./shared/node_modules
COPY --from=build /build/shared/package.json ./shared/package.json
COPY --from=toolchain /root/.cargo/bin/ripsed /usr/local/bin/ripsed

# Verify the agent toolset and that the human-only tools are really gone.
RUN set -e; \
    rg --version | head -1; \
    zg --version | head -1; \
    ast-grep --version | head -1; \
    sg --version | head -1; \
    ripsed --version | head -1; \
    docker --version | head -1;  \
    ! command -v fzf >/dev/null 2>&1 \
 && ! command -v fdfind >/dev/null 2>&1 && ! command -v fd >/dev/null 2>&1 \
 && ! command -v bat >/dev/null 2>&1 && ! command -v batcat >/dev/null 2>&1 \
 && ! command -v rgr >/dev/null 2>&1

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

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:27681/health || exit 1

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["--mode", "server", "--host", "0.0.0.0"]