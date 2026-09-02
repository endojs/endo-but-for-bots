# Security model

`@endo/codex-sandbox` treats Codex and every command it launches as untrusted
code. The `CodexClient` is a protocol adapter, not a sandbox or a credential
manager. Its caller must provide an `@endo/sandbox` slice with the exact mounts,
network access, resource limits, and credentials intended for one session.

## Authority boundaries

- One client represents one Codex thread, one workspace, and one disposable
  `CODEX_HOME`. The home separates sessions but is not secret from model-run
  commands: they share the Codex process UID and can address it directly.
- `auth.json` is password-equivalent. Do not place it or another reusable token
  anywhere in this image, and never mount a machine-wide Codex home into a
  slice. A future provisioner must put a revocable, session-scoped credential
  broker or API proxy behind a separate protection boundary; a same-UID file
  mount is not a credential boundary.
- App-server requests (approvals, user input, dynamic tools, token refresh, and
  future request methods) are denied by this core. Adding a request handler is
  an authority change and requires an explicit capability plus security review.
- The default app-server approval policy is `never` because the outer slice is
  the enforcement boundary. This is safe only when that slice is actually
  confined to the declared workspace and network/resource policy.
- Codex API access and tool-process Internet access need different authority.
  The hosted provisioner must ensure a shell command cannot inherit the API
  credential path or use Codex's API channel as general outbound network access.
- Closing a reply reader sends `turn/interrupt`. A cancelled turn is never
  automatically replayed because it may already have produced side effects.
- `turn/interrupt` does not stop background terminals spawned by a turn. Stop
  means the foreground turn reached `turn/completed(status: "interrupted")`,
  not that every descendant process is gone. Only disposing the session slice
  is a security teardown.

The transport bounds individual JSONL records, cumulative process output, turn
events, turn bytes, and stderr capture. Reaching those bounds fails the turn or
process rather than dropping security-relevant events. Displayed tool arguments
and results are separately truncated for the provider-neutral UI stream; that
stream is not an audit log and the full event must be recorded by the future
durable audit capability.

If a transport arrives after startup was abandoned, the client closes it and
reports any close failure through `reportCleanupFailure` and `status()`. A
hosted provisioner must connect the callback to durable operator-visible
telemetry and dispose the enclosing slice independently.

See [MERGE-BLOCKERS.md](./MERGE-BLOCKERS.md) before enabling this package in a
hosted deployment.

For private vulnerability reports, follow the repository-level Endo security
policy.
