# Shared development image

Claude, Codex, and OpenCode use this same development tool layer, with separate
CLI/bridge overlays and unchanged sandbox authority.
The direct-provider worker image remains minimal and separate.
This coordinated base refresh uses Node 22.23.2 (already used on Tokyo) and the
immutable 2026-09-20 Debian snapshot, avoiding a Claude/OpenCode Node downgrade.
It provides bash, CA certificates, curl, git, ripgrep, C/C++ build tools, Python,
pip, venv, OpenSSL, and tar; it does not add Rust or Go.

Build the base once, then reuse its immutable local image ID for each overlay:

```sh
export ENDO_DEV_IMAGE=$(sh packages/hosted-agent/oci/dev/build.sh linux/amd64)
sh packages/claude-sandbox/oci/build.sh
sh packages/codex-sandbox/oci/build-reproducible.sh
OPENCODE_BINARY=/path/to/opencode sh packages/opencode-sandbox/oci/build-reproducible.sh
```

Without `ENDO_DEV_IMAGE`, each wrapper builds the common base first.
An override must be an immutable ID or digest reference already in the selected
engine's local image store, and must match the requested platform.
Use the same `ENGINE` and platform for all builds (Podman by default).
The common builder and CLI wrappers also support `ENGINE=docker`.
Reproducibility verification remains the Podman path; Docker build compatibility
does not claim identical image bytes across engines.
Deployment must record and pin the resulting final image digest, not a mutable tag.
Never put subscription credentials in build arguments or images.

Codex retains its integrity-checked npm lockfile and reproducibility verifier.
Claude is pinned to 2.1.233; OpenCode's existing binary/source selection is unchanged.
These changes do not claim full Claude/OpenCode reproducibility: Claude's npm
dependency graph is not locked, and OpenCode's source build still fetches its model
catalog and uses the existing Bun build stage.
Future base refreshes should update and verify all three overlays together.

Smoke-test all final images for `curl`, `git`, `rg`, `make`, `gcc`, `g++`, `python3`,
`pip3`, `openssl`, `tar`, and `bash`, plus their respective CLI versions.
Image availability alone does not grant network access; dependency downloads still
require the session's public-internet policy.
