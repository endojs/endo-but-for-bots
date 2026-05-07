---
"@endo/daemon": minor
"@endo/cli": minor
---

Add HttpClient agent tool: a host-controlled capability for outbound HTTP
requests against an explicit origin allowlist. The kit enforces a
sliding-window rate limit (default 60 req/min) and a hard byte cap on
response bodies (default 10 MB) using a streaming reader that aborts
the upstream stream when the cap is reached, so a malicious origin
cannot exhaust daemon memory regardless of the Content-Length header.
The control facet allows adjusting the allowlist, rate limit, and byte
cap, and revoking the client. The CLI command `endo http-client --name
<petname> --origins <urls>` provisions one for the host's agent.
