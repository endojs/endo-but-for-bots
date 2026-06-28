# The Agent C provisioner drive — AGENT RUNBOOK

You are reading this from the **plaintext deploy partition** of dan's provisioner USB. This drive does
two jobs at once:

1. **Provision a fresh archua / Agent C instance** on a new machine or VM (this partition + the bootable
   archua image).
2. **Carry dan's personal layer** as an encrypted partition that, when decrypted with *his* passphrase,
   turns a clean instance into his full personal instance. Without it, nothing personal is on the box.

This document is written so that **an agent (or a person) can take this drive, stand up a working Agent C
on a new box, and run it — without any other knowledge.** Everything you need is here or on this partition.

---

## Drive layout (GPT, ~116 GB)

| Part | Role | Encrypted? | Holds |
| ---- | ---- | ---------- | ----- |
| **p1** | **deploy + docs** (this partition) | no — readable anywhere | the bootable archua image, the Agent C source snapshot, the install scripts, and THIS runbook |
| **p2** | **personal volume** | **yes — LUKS2, dan's passphrase** | dan's secrets, vault, state, root cap. Mounts at `FIELD_PERSONAL_ROOT` → personal mode |

The two are independent: you can provision + run a clean **platform-mode** instance from p1 with no
passphrase at all. p2 is needed *only* to become dan's personal instance.

---

## The two modes (this is the whole architecture)

Agent C reads one switch — `FIELD_PERSONAL_ROOT` (resolved in `field-config.mjs`):

- **platform mode** (no personal volume mounted) — a clean, multi-tenant Agent C. No vault, no secrets,
  no personal/admin powers. Each user is a tenant isolated by construction. **This is the default a fresh
  provisioned box boots into.** Safe to run for strangers; safe to carry.
- **personal mode** (p2 decrypted + mounted) — dan's vault + secrets + root cap + admin bindings load
  *from the volume*; dan becomes the privileged "user 0". Pull the drive → none of it is on the box.

So: **provision → platform mode works immediately. Plug + unlock p2 → personal mode.**

---

## Part A — provision a fresh instance (platform mode)

Target: a NUC, laptop, VM, or Raspberry Pi (x86_64 or arm64) with a Linux you control.

1. **OS.** Either boot the bootable archua image on p1 and run its installer (`install/` → `install.sh`
   → `post-install.sh`; see the archua repo's `install/README.md`), OR use any existing Linux box.
2. **Runtime.** Install Node ≥ 24 and git. (The reference instance runs Node 25.)
   ```bash
   node --version   # ≥ 24
   ```
3. **Source.** Copy the Agent C monorepo snapshot from this partition (`./agent-c-src/`) to the box, or
   `git clone` the fork, then install workspace deps:
   ```bash
   cp -r /mnt/<this-partition>/agent-c-src ~/endo-bfb-llm   # or git clone
   cd ~/endo-bfb-llm && npx corepack yarn install
   ```
4. **Service.** Install the systemd --user unit (template on this partition at `./systemd/voice-agent.service`):
   ```bash
   mkdir -p ~/.config/systemd/user
   cp /mnt/<this-partition>/systemd/voice-agent.service ~/.config/systemd/user/
   systemctl --user daemon-reload && systemctl --user enable --now voice-agent
   ```
5. **Verify platform mode.** It must come up WITHOUT any personal data:
   ```bash
   journalctl --user -u voice-agent -n 20 | grep 'field mode'
   # → "field mode: platform | personal-root: ..." (no vault, no secrets)
   curl -s localhost:8778/ >/dev/null && echo up
   ```
   A platform-mode instance can serve invited tenants (each gets the least-privilege STARTER_RING and can
   request more). It has NO inference keys until dan's volume is present, OR you provide a platform key.

### LAN-only event networking (the venue compromise)
To serve the instance on the **event LAN only** (not tailnet, not public), with share links that work
only on the local network — and **text-only** is fine (dan confirmed; the mic needs HTTPS which we skip on
plain-http LAN):
```bash
systemctl --user edit voice-agent      # add a drop-in:
#   [Service]
#   Environment=BIND=<LAN-IP>,127.0.0.1
#   Environment=PUBLIC_BASE_URL=http://<LAN-IP>:8778
#   Environment=EVENT_MODE=1            # text-only; no mic/secure-context assumptions
systemctl --user restart voice-agent
```
Now every share/invite/cap link embeds `http://<LAN-IP>:8778/...` — live only for devices on that LAN.

---

## Part B — become dan's personal instance (personal mode)

Only dan can do this; it needs his passphrase. The tool is `agent-c-src/packages/chat/voice-agent/field-personal`.

```bash
sudo field-personal unlock     # asks dan's passphrase → decrypts p2, mounts it, restarts in personal mode
field-personal status          # → "service mode would be: personal"
# ... when done:
sudo field-personal lock       # unmounts + closes p2, restarts in platform mode (nothing personal left running)
```
`unlock` writes a systemd drop-in setting `FIELD_PERSONAL_ROOT=<mount>` and restarts; `lock` clears it.
There is **no keyfile on the host** — the machine cannot decrypt p2 on its own.

First-time setup of a brand-new personal volume (dan, once) is in
`agent-c-src/packages/chat/voice-agent/designs/packing-up-for-dweb.md` → "The provisioner drive".

---

## Security invariants (do not violate)
- The host stores **no LUKS key** — only dan's passphrase unlocks p2.
- Personal/admin powers and secrets exist **only** while p2 is mounted. Platform mode = none on disk.
- Never render/persist a swissnum (cap) to screen/URL/log. User caps are stored hashed.
- Public-internet exposure is an explicit per-instance decision. Default = tailnet; event = LAN.
- A tenant cap names only its own namespace (designation by reference); no tenant can reach another's
  data or dan's personal/admin caps.

---

*Provenance: built for "Packing up for Dweb". Full design + phase plan:
`agent-c-src/packages/chat/voice-agent/designs/packing-up-for-dweb.md`.*
