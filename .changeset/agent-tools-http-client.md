---
"@endo/daemon": minor
"@endo/cli": minor
---

Add HttpClient agent tool: a host-controlled capability for outbound HTTP
requests against an explicit origin allowlist. The kit enforces a
sliding-window rate limit (default 60 req/min), a hard byte cap on
response bodies (default 10 MB) using a streaming reader that aborts
the upstream stream when the cap is reached, and a per-request timeout
(default 30 s) that aborts slow-loris connections so a malicious
origin cannot exhaust daemon memory or pin promises indefinitely.
Outbound requests use `redirect: 'manual'`, so a server cannot steer
the daemon off the allowlist with a `Location:` header (SSRF). The
control facet allows adjusting the allowlist, rate limit, byte cap,
and timeout, and revoking the client. The CLI command `endo
http-client --name <petname> --origins <urls>` provisions one for the
host's agent.

Known limitation: the allowlist is name-based (matched against
`new URL(url).origin`). An allowlisted hostname whose DNS A record
resolves to a loopback or RFC1918 address still passes, and a DNS
rebinding attack between the lookup and the connect can swap a public
address for a private one. Operators should treat the allowlist as a
*hostname* gate, not an *address* gate, and avoid allowlisting
attacker-controlled domains. A future opt-in resolver that pins the
URL to a public IP before connect is tracked as a TODO.
