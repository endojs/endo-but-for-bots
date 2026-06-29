#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd -- "$script_dir/.." && pwd)
image=${1:-endojs/daemon:latest}
context_dir=${ENDO_DOCKER_CONTEXT:-"$script_dir/.build/daemon"}

rm -rf "$context_dir"
mkdir -p "$context_dir/bundles" "$context_dir/chat"

(cd "$repo_root/packages/familiar" && yarn step:bundle)
(cd "$repo_root/packages/chat" && yarn build)

cp "$repo_root/packages/familiar/bundles/endo-cli.cjs" "$context_dir/bundles/"
cp "$repo_root/packages/familiar/bundles/endo-daemon.cjs" "$context_dir/bundles/"
cp "$repo_root/packages/familiar/bundles/worker-node.cjs" "$context_dir/bundles/"
if [ -f "$repo_root/packages/familiar/bundles/endo-lal-setup.cjs" ]; then
  cp "$repo_root/packages/familiar/bundles/endo-lal-setup.cjs" "$context_dir/bundles/"
fi
if [ -f "$repo_root/packages/familiar/bundles/agent.js" ]; then
  cp "$repo_root/packages/familiar/bundles/agent.js" "$context_dir/bundles/"
fi
if [ -d "$repo_root/packages/familiar/bundles/primer" ]; then
  cp -R "$repo_root/packages/familiar/bundles/primer" "$context_dir/bundles/"
fi
cp -R "$repo_root/packages/chat/dist/." "$context_dir/chat/"
cp "$script_dir/docker-entrypoint.sh" "$context_dir/"

docker build -f "$script_dir/Dockerfile" -t "$image" "$context_dir"
