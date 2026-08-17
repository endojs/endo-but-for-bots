---
'@endo/cli': minor
'@endo/lal': patch
---

Add `endo http mk`, which mints a confined outbound-HTTP client capability under
a host-curated policy and registers it under a single pet name:

```
endo http mk <name> --origin <origin> [--origin <origin>...]
  [--max-requests-per-minute <n>] [--max-response-bytes <n>]
  [--policy-mode strict|tofu-auto [--acknowledge-unbounded]] [--as <host>]
```

`--origin` is required and repeatable; each value is an origin
(`scheme://host[:port]`, http: or https:) and is normalized to its canonical
serialization, so a browser-copied form with a trailing slash or an explicit
default port is accepted. A value carrying a path, query, fragment, or userinfo
(for example `https://api.example.com/v1`) is refused by flag name rather than
silently widened to the whole host.
The guard knobs are optional and default to 60 requests/minute and a 1 MiB
response cap when unset; `--policy-mode` defaults to `strict`.

Under `--policy-mode strict` the client can reach only the listed origins.
Under `--policy-mode tofu-auto` it auto-allows any first-seen origin, so
`--origin` becomes a pre-seed rather than a bound — the allowlist no longer
confines outbound reach. Because Phase 1 ships no verb to inspect or revoke that
grant, `tofu-auto` additionally requires `--acknowledge-unbounded`; prefer
`strict` until the policy-inspection and revocation verbs land.

`--as` names a host; the underlying capability is host-only, so a guest cannot
mint one.

On a successful mint the verb echoes the canonical origin allowlist and the
policy mode on stderr (the daemon-verbatim form, which can differ from what was
typed), so the confinement is legible without an inspect verb.

Re-running `mk` on a name that already denotes a client rebinds the name to the
newly minted client under the new policy; the previous client's name reference
is dropped, and the daemon collects the orphaned client unless another edge
still retains it (for example it was granted to a guest under another name).
Revocation of a still-referenced client lands with a later verb.

Policy mutation and revocation are not yet exposed on the CLI.
