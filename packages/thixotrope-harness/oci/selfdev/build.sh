#!/bin/sh
# Only committed sources and package manifests enter the local build context.
set -eu
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
ref=$(git -C "$repo" rev-parse "${1:-HEAD}^{commit}")
ctx=$(mktemp -d)
trap 'rm -rf "$ctx"' EXIT
mkdir "$ctx/rust-src" "$ctx/manifests"
git -C "$repo" archive "$ref" -- Cargo.toml Cargo.lock rust | tar -x -C "$ctx/rust-src"
git -C "$repo" archive "$ref" -- package.json yarn.lock .yarnrc.yml ':(glob)packages/*/package.json' | tar -x -C "$ctx/manifests"
cp "$here/prepare.sh" "$ctx/prepare.sh"
image="thix-selfdev:${ref}"
base=node@sha256:e0d149b4727ac0c20d9774e801e423d7a946a0bffced886f42cfe9cd3c67820a
if ! docker image inspect "$base" >/dev/null 2>&1; then docker pull "$base" >&2; fi
# BuildKit resolves digest references through the registry. A local tag for the
# verified base lets Docker Desktop use its cached layers without registry access.
base_tag=thix-selfdev-node:e0d149b4727a
docker tag "$base" "$base_tag"
docker build --build-arg "NODE_IMAGE=$base_tag" --file "$here/Containerfile" --tag "$image" "$ctx" >&2
docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$image"
