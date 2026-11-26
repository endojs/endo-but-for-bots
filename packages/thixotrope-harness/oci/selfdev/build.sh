#!/bin/sh
# Build the self-development runner image and print its digest pin.
# Usage: build.sh [--runtime docker|podman] [git-ref]
# The runtime matches project-preset.mjs --runtime (default docker). Rootless
# image stores are per user: run it as the user the harness runs as.
# Only committed sources and package manifests enter the local build context.
set -eu
runtime=docker
while [ $# -gt 0 ]; do
  case "$1" in
    --runtime) runtime=${2:?--runtime needs docker or podman}; shift 2 ;;
    --runtime=*) runtime=${1#--runtime=}; shift ;;
    --) shift; break ;;
    -*) echo "unknown option $1" >&2; exit 2 ;;
    *) break ;;
  esac
done
case "$runtime" in
  docker | podman) ;;
  *) echo "--runtime must be docker or podman, got $runtime" >&2; exit 2 ;;
esac
[ $# -le 1 ] || { echo 'usage: build.sh [--runtime docker|podman] [git-ref]' >&2; exit 2; }
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
ref=$(git -C "$repo" rev-parse "${1:-HEAD}^{commit}")
ctx=$(mktemp -d)
trap 'rm -rf "$ctx"' EXIT
mkdir "$ctx/rust-src" "$ctx/manifests"
git -C "$repo" archive "$ref" -- Cargo.toml Cargo.lock rust | tar -x -C "$ctx/rust-src"
git -C "$repo" archive "$ref" -- package.json yarn.lock .yarnrc.yml ':(glob)packages/*/package.json' | tar -x -C "$ctx/manifests"
cp "$here/prepare.sh" "$here/yarn-tools.sh" "$ctx/"
image="thix-selfdev:${ref}"
digest=sha256:e0d149b4727ac0c20d9774e801e423d7a946a0bffced886f42cfe9cd3c67820a
base_tag=thix-selfdev-node:e0d149b4727a
if [ "$runtime" = docker ]; then
  base="node@$digest"
  if ! docker image inspect "$base" >/dev/null 2>&1; then docker pull "$base" >&2; fi
  # BuildKit resolves digest references through the registry. A local tag for the
  # verified base lets Docker Desktop use its cached layers without registry access.
  docker tag "$base" "$base_tag"
  docker build --build-arg "NODE_IMAGE=$base_tag" --file "$here/Containerfile" --tag "$image" "$ctx" >&2
  # The containerd image store records a local build as thix-selfdev@sha256:...
  pin_pattern='thix-selfdev@sha256:[0-9a-f]{64}'
else
  # Fully qualified: a short name needs registries.conf aliases (and, when
  # enforcing, a TTY to ask), which a service user may not have.
  base="docker.io/library/node@$digest"
  if ! podman image exists "$base"; then podman pull "$base" >&2; fi
  # Buildah keeps unqualified local names under localhost/; --pull=never makes
  # the build use the verified base and never the registry.
  podman tag "$base" "localhost/$base_tag"
  # Buildah declares TARGETARCH on its own; passing the host's (amd64, arm64)
  # keeps the Containerfile's choice of rustup binary independent of that.
  arch=$(podman info --format '{{.Host.Arch}}')
  podman build --pull=never --build-arg "NODE_IMAGE=localhost/$base_tag" \
    --build-arg "TARGETARCH=$arch" --file "$here/Containerfile" --tag "$image" "$ctx" >&2
  # Podman records a local build as localhost/thix-selfdev@sha256:...
  pin_pattern='localhost/thix-selfdev@sha256:[0-9a-f]{64}'
fi
pin=$("$runtime" image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$image" |
  grep -Ex "$pin_pattern" | head -n 1 || true)
if [ -z "$pin" ]; then
  if [ "$runtime" = docker ]; then
    echo 'Docker did not record a local repository digest. Use the containerd image store.' >&2
  else
    echo 'Podman did not record a localhost/thix-selfdev repository digest for the build.' >&2
  fi
  exit 1
fi
# The pin must name the image just built, not an older one of the same name.
built=$("$runtime" image inspect --format '{{.Id}}' "$image")
pinned=$("$runtime" image inspect --format '{{.Id}}' "$pin")
if [ "$built" != "$pinned" ]; then
  echo "The digest pin $pin names another image than $image." >&2
  exit 1
fi
printf '%s\n' "$pin"
