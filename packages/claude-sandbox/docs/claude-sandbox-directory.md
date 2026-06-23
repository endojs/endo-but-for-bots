# `claude-sandbox/` — Claude Sandbox factory (host side)

This directory lives on the machine that runs the containers (Linux + podman).
Below is each object and **what authority sharing it grants**.

## Objects

- **`controller`** — the "Create Claude Sandbox" form/exo. **Delegatable**: the
  one object meant to be shared. A peer holding it can call `createSession(...)`
  to run Claude in a container on this host against a `Filesystem` cap they
  supply. It cannot reach anything else in this directory.
- **`profile`** — the factory's guest **agent**. Holds `host-agent` = **full
  authority** over this host's Endo daemon. **Never share** — handing it out is
  equivalent to giving away the host.
- **`handle`** — the factory guest's mailbox handle. Low direct authority
  (messaging the guest); host-internal, don't share casually.
- **`sandbox-factory`** — the `@endo/sandbox` plugin; runs with `@agent`
  (`provideHostPath`, mints containers with host bind-mounts). **High authority —
  host trusted compute base, never share off-host.**
- **`fs-mounter`** — the `@endo/9p-server` mounter; ambient host `mount`/`umount`
  (often via `sudo`). **High authority over the host kernel — host TCB, never
  share off-host.**

## Guiding principle

Delegate only **`controller`**. Everything else is host trusted compute base.
The credentials factory lives on the **peer**, not here (its own
`claude-credentials/` directory). The peer passes a `Filesystem` cap and a
`ClaudeCredentials` cap into `createSession`; the host only ever sees a
short-lived materialised secret, never a long-lived key.

## Credential exposure

The short-lived secret the host receives is injected as a process environment
variable into the container at spawn time.
Any code the agent runs inside the slice — tool subprocesses, MCP servers, hooks
— inherits the parent environment and can therefore read the secret.
Claude Code does not strip the credential variable from tool subprocesses.
The containment boundary is the sandbox (network egress control + short-lived
revocable secret), not in-container masking.
See `DESIGN.md` § "9. Credential exposure through the sandbox environment" for
the full threat model and mitigations.
