---
'@endo/cli': minor
---

Add `endo http mk` (Phase 1 of `designs/cli-http-client.md`).

The verb mints a confined outbound-HTTP client capability under a host-curated
policy and registers it under a single pet name:

```
endo http mk <name> --origin <url> [--origin <url>...]
  [--max-requests-per-minute <n>] [--max-response-bytes <n>]
  [--policy-mode strict|tofu-auto] [--as <agent>]
```

It rides the HTTP client that already landed on the daemon rather than
introducing a new formula: the host method is
`provideHttpClient(name, policy)` (backed by `@endo/exo-http-client` over
`@endo/http-confine`), which returns one client with its control facet held
host-side (reachable via `getHttpClientControl`). Accordingly the verb takes a
*policy* — an origin allowlist plus optional rate / size / mode guards — not the
controller/client formula pair the original design assumed. The daemon's policy
normalizer is the authority on validity, so a malformed origin or guard surfaces
as its structured error on the CLI invocation.

This is CLI-only; no `@endo/daemon` change is needed. Policy mutation and
revocation through the retained control facet, and the `allow`/`deny`/`revoke`/
`inspect` verbs, follow in later phases.
