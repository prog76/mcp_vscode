#!/usr/bin/env bash
# Refresh the vendored mcp-router tarball.
#
# prog76/mcp-router is a PRIVATE repo, so `github:prog76/mcp-router#vX.Y.Z`
# cannot resolve in CI (a workflow's GITHUB_TOKEN is scoped to its own repo) nor
# in a Docker build. Instead the router is consumed as a tarball committed under
# vendor/, which also makes image builds offline-reproducible.
#
# Usage:
#   scripts/vendor-router.sh              # pack the sibling checkout as-is
#   scripts/vendor-router.sh v0.2.5       # pack a tag from the GitHub remote
#
# Then commit vendor/ plus the `file:../vendor/mcp-router-<version>.tgz` bump in
# agent/package.json and extension/package.json.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
router_dir="${MCP_ROUTER_DIR:-$(dirname "$repo_root")/mcp-router}"
tag="${1:-}"

if [ ! -d "$router_dir" ]; then
    echo "error: router checkout not found at $router_dir (set MCP_ROUTER_DIR)" >&2
    exit 1
fi

if [ -n "$tag" ]; then
    echo "==> fetching $tag in $router_dir"
    git -C "$router_dir" fetch --tags --quiet origin
    git -C "$router_dir" checkout --quiet "$tag"
fi

# `npm pack` runs the router's `prepare` (tsc), so dist/ is always current.
version="$(node -p "require('$router_dir/package.json').version")"
echo "==> packing mcp-router@$version"
rm -f "$repo_root/vendor/mcp-router-"*.tgz "$repo_root/vendor/mcp-router-"*.sha256
npm pack --pack-destination "$repo_root/vendor" --silent --prefix "$router_dir" >/dev/null
mv "$repo_root/vendor/mcp-router-$version.tgz" "$repo_root/vendor/mcp-router-$version.tgz"
( cd "$repo_root/vendor" && sha256sum "mcp-router-$version.tgz" >"mcp-router-$version.tgz.sha256" )

# Point both consumers at the new tarball.
for pkg in agent extension; do
    node -e '
        const fs = require("fs");
        const file = process.argv[1];
        const version = process.argv[2];
        const json = JSON.parse(fs.readFileSync(file, "utf8"));
        json.dependencies["mcp-router"] = `file:../vendor/mcp-router-${version}.tgz`;
        fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
    ' "$repo_root/$pkg/package.json" "$version"
    echo "==> $pkg/package.json -> file:../vendor/mcp-router-$version.tgz"
done

echo "==> done. Commit vendor/ and the two package.json bumps, then reinstall:"
echo "    npm install --prefix agent && npm install --prefix extension"