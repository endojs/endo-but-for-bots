---
'@endo/cli': minor
---

Add `endo http mk`, which mints a confined outbound-HTTP client capability under
a host-curated policy and registers it under a single pet name:

```
endo http mk <name> --origin <origin> [--origin <origin>...]
  [--max-requests-per-minute <n>] [--max-response-bytes <n>]
  [--policy-mode strict|tofu-auto] [--as <host>]
```

`--origin` is required and repeatable; each value is an origin
(`scheme://host[:port]`, http: or https:) and is normalized to its canonical
serialization, so a browser-copied form with a trailing slash or an explicit
default port is accepted. The guard knobs are optional and default to 60
requests/minute and a 1 MiB response cap when unset; `--policy-mode` defaults to
`strict`.

Under `--policy-mode strict` the client can reach only the listed origins. Under
`--policy-mode tofu-auto` it auto-allows any first-seen origin, so `--origin`
becomes a pre-seed rather than a bound — the allowlist no longer confines
outbound reach. Prefer `strict` until the policy-inspection and revocation verbs
land.

`--as` names a host; the underlying capability is host-only, so a guest cannot
mint one.

Re-running `mk` on a name that already denotes a client rebinds the name to the
newly minted client under the new policy; the previously bound client is not
revoked (revocation lands with a later verb), so prefer a fresh name for now.

Policy mutation and revocation are not yet exposed on the CLI.
