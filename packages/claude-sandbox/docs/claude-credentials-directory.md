# `claude-credentials/` — Claude Credentials factory (peer side)

This directory normally lives on the machine that **owns the Anthropic
account**, not the sandbox host. The long-lived API key/token never leaves this
peer. Below is each object and **what authority sharing it grants**.

## Objects

- **`controller`** — the "Create Claude Credentials" form/exo. It mints a
  `ClaudeCredentials` cap from a key you submit on its form. The sensitive
  object is the **minted credential**, not this exo.
- **`profile`** — the factory's guest **agent**. Holds `host-agent` = **full
  authority** over *this* (peer) machine. **Never share.**
- **`handle`** — the guest's mailbox handle. Low authority; don't share
  casually.

## What you share off-machine

The **minted `ClaudeCredentials` cap** (named when you submit the form), handed
to the sandbox host's `createSession`. The host only ever receives a short-lived
**materialised** secret at container-spawn time — never the long-lived key,
which stays on this peer.
