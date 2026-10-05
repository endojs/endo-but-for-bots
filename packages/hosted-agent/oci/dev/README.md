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

## Running repository tests in a development slice

Clone the repository into native HOME, for example `/home/node/ebfb`.
Put package caches, installed toolchains and build output there too; the 9P
workspace is for Endo files, not a package manager's native dependency tree.
Use `corepack yarn` directly when the read-only image prevents global shim setup.
For optional user shims, create `/home/node/bin` first, then run
`corepack enable --install-directory /home/node/bin` and add the directory to `PATH`.
Keep the repository's immutable lockfile and lifecycle-script policy.
The managed public-internet environment supplies both ordinary and Yarn-specific
proxy settings; internet-off supplies neither and still denies public networking.

After `corepack yarn install --immutable`, build the declarations before tests
that verify generated tool declarations.
Turbo's ordinary `build` tasks do not provide those declaration prerequisites:

```sh
corepack yarn build:types
CI=1 corepack yarn turbo run test --concurrency=2 --continue=always \
  --filter='!@endo/skel' --env-mode=loose --summarize
```

The `@endo/skel` exclusion matches the repository's root test command; it is a
package template, not an omitted application suite.
`CI=1` uses AVA's CI concurrency and the Turbo limit bounds parallel workspaces.
Loose environment mode retains the supplied proxy settings in child tasks.
Run in the foreground and save complete output in HOME.
If the shell deadline requires batching, split workspace filters without changing
test timeouts or dropping build prerequisites.
The daemon suite is serial and may need several explicit test-file batches;
use paths such as `test/account-bindings-durability.test.js` relative to its
workspace, not bare filenames.
An individually slow file can use exhaustive, non-overlapping AVA title batches.
Verify the installed matcher's behavior and the actual selected arguments;
a no-matching-tests error provides no coverage.
This command exercises JavaScript workspace `test` scripts, not every separate
Rust, XS, test262, lint or typecheck CI lane.
Browser downloads can live in HOME, but the base image does not claim every
browser runtime library or other project's optional system dependencies.
On Debian, APT can use user-owned lists, cache and a copy of installed-package
status for signed download-only dependency resolution.
Extract the resulting packages with `dpkg-deb -x` into a HOME prefix, then use
that prefix's binary/library paths for the relevant commands.
This keeps normal repository verification and needs no root or writable system
mount; do not replace it with disabled signature checks or a host package install.
The Tokyo browser suites passed with this approach.
The hosted-agent suite also needs `pgrep` from `procps`; download/extract its
packages into a HOME prefix and include its binary and library paths.
The locked Electron package's explicit `install.js` also worked with
`ELECTRON_GET_USE_PROXY=1`; it retained checksum verification without globally
enabling dependency scripts or fetching an unpinned installer.
