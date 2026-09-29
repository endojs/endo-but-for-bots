# Inference evidence probe (#1357)

Not package API. `run-probe.mjs` drives real `--bare` turns through
`@endo/inference`'s enrichers over `makeClaudeCliBackend`, with every
credential held in the daemon secret manager (`makeSecretManager`, in memory)
and read through a `SecretBlob` facet on each turn. `guest-mcp-server.mjs` is a
dependency-free stdio MCP stand-in for a guest facet (`writeText`, `readText`)
whose store the harness reads directly to verify effects.

To deploy to a host that lacks `@endo/*` packages, bundle it:

```sh
NODE_PATH=packages/daemon/node_modules npx esbuild@0.25.10 \
  packages/claude/probe/run-probe.mjs --bundle --minify --platform=node \
  --format=esm --target=node22 --outfile=probe-bundle.min.mjs
node probe-bundle.min.mjs --guest-server guest-mcp-server.mjs \
  --executable "$(command -v claude)" --version "$(claude --version | cut -d' ' -f1)" \
  --cred A=<file> --cred B=<file> --out probe.jsonl --scratch <dir> --positive 10
```

`evidence/` holds the JSON-lines logs from the 2026-09-29 runs (one line per
turn plus a summary line). They carry `secretId`s and environment variable
names, never credential bytes.
