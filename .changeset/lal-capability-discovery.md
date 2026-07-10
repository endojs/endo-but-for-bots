---
'@endo/lal': minor
---

Discover the coding tools a guest's granted capabilities afford at worker startup and bridge them into pi-agent-core tools, and extend the provisioning form with `projectPath` and `capabilities` (comma-separated `fs,shell,git`) fields.
On submit the manager mints one writable project mount and grants the requested capabilities into the new guest under the canonical discovery pet names, so the guest's own startup discovery registers exactly those tools.
A static tool name wins over a discovered one, discovery failure is non-fatal, and a form-granted `Shell` is bounded by a default allowlist, a 60 s timeout, and a 1 MiB output cap (daemon-agent-tools Phase 4).
