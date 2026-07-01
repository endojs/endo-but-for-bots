# VAT-MIGRATION — moving dan's vat: archua → M1 MacBook Pro (DWeb Camp) → back

Companion to `PROVISIONER-DRIVE.md` (stand up an instance) and `designs/vat-affinity.md` (the
design this executes — **V0: one live vat at a time, moved bodily**). The vat's body is the
encrypted personal volume: `root.swiss` + config + state + vault travel together, so **existing
cap links keep working on the new instance**. The one rule that makes V0 safe:

> **Never run two live instances of the same vat.** Chats and purses are last-write-wins JSON;
> scheduled agents fire wherever the vat is mounted. Stop the old instance BEFORE starting the
> new one — in both directions.

---

## 0 — Before travel (on archua, ~30 min, do it the day before)

1. **Know where you stand.** `field-personal status` — mode, mount state, whether plaintext
   originals remain on the internal disk.
2. **Make the volume current + take a fresh off-site backup** (drive loss at camp must not equal
   vat loss — the friky backup is the vat's spare body):
   ```bash
   field-personal migrate     # reconcile internal-disk personal data → the mounted volume
   field-personal verify      # must pass
   field-personal backup      # raw LUKS partition image → friky (ciphertext only)
   field-personal backup-file # gpg-encrypted tar of the decrypted contents — THIS is the copy
                              # a mac can open (see Route 2). Put it on the drive's plaintext
                              # p1 partition or another stick you carry.
   ```
3. **Stop and DISABLE the instance** (disable matters: the NUC may stay powered at home and
   reboot — it must not come back up as a second live vat):
   ```bash
   systemctl --user stop voice-agent
   systemctl --user disable voice-agent
   ```
4. **Timers — know which travel and which don't.**
   - **Scheduled agents + in-app timers travel with the vat** (projects/scheduled-agent store is
     in `VOICE_STATE_DIR`, on the volume). They will fire on the mac. Stopping archua's service
     (step 3) is what prevents double-fire.
   - **`timer-runner.service` does NOT travel**: its store is
     `~/.local/state/field-timers/schedule.json` — host-local, not in the drive's bind map. Its
     timers stay home. Stop it too if any of its `command` actions would misbehave without the
     vat: `systemctl --user stop timer-runner`.
5. **Public name stays home.** `agentc.chu` is NOT re-pointed — public binding is an explicit
   per-instance operator request (`public-domain-binding-explicit-only`), and the default answer
   is no. With voice-agent stopped the public name serves nothing; that is correct. (Optionally
   stop the ngrok sidecar for a cleaner error.)
6. **Detach the body.** `sudo field-personal lock` — unmounts + closes the LUKS volume; archua is
   now platform-mode-or-dark with nothing personal on disk. Pull the drive. Travel.

---

## 1 — At camp: bring the vat up on the M1

macOS cannot mount LUKS and has no systemd, so there are two routes. **Route 1 keeps the drive as
the single body (no merge on return). Route 2 forks the body onto the mac (simpler
runtime, but the copy becomes the truth and MUST be copied back).**

> **CHOSEN (dan, 2026-07-01): Route 2.** The step-by-step guide is `RUN-ON-MAC.md`.

### Route 1 — Linux VM on the M1 (drive stays the body)

Run the whole instance inside an arm64 Linux VM (UTM/Lima) with the USB drive passed through.
Inside the VM it is exactly the archua procedure:

1. Provision the VM per `PROVISIONER-DRIVE.md` Part A (Node ≥ 24, source snapshot from p1, the
   systemd --user unit).
2. `sudo field-personal unlock` → personal mode. Same `root.swiss`, same caps, same chats.
3. Install tailscale in the VM (or port-forward :8778 to the mac and `tailscale serve` on the
   mac) so the tailnet origin + HTTPS (mic needs a secure context) come up.

### Route 2 — native on macOS via `FIELD_PERSONAL_ROOT` (copy route)

1. **Restore the personal data onto encrypted mac storage.** Create an encrypted APFS volume
   (Disk Utility), then unpack the `backup-file` tar into it:
   ```bash
   # backup-file's actual format is tar | zstd | gpg — decode in that order (brew install gnupg zstd):
   gpg -d field-personal-<stamp>.tar.zst.gpg | zstd -d | tar -x -C /Volumes/FieldPersonal
   # yields: config/ vault/ state/ personal.json env
   ```
2. **Runtime.** Node ≥ 24 + git; copy or clone the source (p1 snapshot works);
   `npx corepack yarn install`.
3. **Run with the env-route mode switch** (no systemd — `field-personal unlock`'s drop-in doesn't
   exist here; `FIELD_PERSONAL_ROOT` alone flips the mode, per `field-config.mjs`):
   ```bash
   export FIELD_PERSONAL_ROOT=/Volumes/FieldPersonal
   set -a; source "$FIELD_PERSONAL_ROOT/env"; set +a   # the volume-local inference keys
   export FIELD_LOCKDOWN=1
   export PUBLIC_BASE_URL=https://<mac-name>.taildd002.ts.net   # the tailnet origin (below)
   node packages/chat/voice-agent/server.mjs   # tmux / launchd to taste
   ```
4. **Origin.** `tailscale serve --bg 8778` on the mac → `https://<mac-name>.taildd002.ts.net`
   is the new tailnet origin (HTTPS = mic works). For handing links to strangers on the camp
   LAN, use the `EVENT_MODE` recipe in `PROVISIONER-DRIVE.md` instead (LAN-only, text-only).

### Either route — first-open caveat + smoke test

- **Caps are per-origin in the browser** (`localStorage`): at the new origin, re-present your cap
  link once (from your password manager / carried QR — never print `root.swiss`). Existing chats
  load; the cap itself never stopped being valid.
- Smoke: send a message; open an old chat via the cap link; confirm a scheduled agent fires;
  `grep 'field mode' `in the logs → `personal`.

---

## 2 — What works at camp

| | Offline (camp LAN only) | Needs internet |
| --- | --- | --- |
| **Turns/LLM** | Yes, via `AGENT_LLM` → a **local** OpenAI-compatible server on the mac (ollama / llama.cpp / mlx). The default points at tinix `192.168.50.226:8003` — unreachable; set it or turns fail. | Anthropic / OpenRouter models |
| **Voice** | Only with a local whisper: `STT_URL` defaults to tinix `:8000` — unreachable. Run whisper locally or accept **text-only**. | — |
| **Chats, homes, purses, specialists, components, vault notes, timers/scheduled agents** | Yes — all vat-local files on the volume. | — |
| **Share/invite links** | Yes, on the tailnet or camp LAN per origin above. | Public (`agentc.chu`) stays home, unbound at camp |
| **Not available regardless** | tinix imagegen / GPU Studio leases, Home Assistant, the `agent-*` personas, dietician/kazputer bridges, friky (backups, library), email send, ntfy push — all bind to home infrastructure. If camp internet + tailscale are up, the tailnet-reachable ones (tinix, friky, ntfy) come back; the LAN-only ones don't. | |

---

## 3 — Return (mac → archua)

Order is the same law reversed: **stop the mac instance first.**

1. On the mac: stop the server (and `tailscale serve reset`). Route 2: eject the APFS volume
   only after step 3.
2. Travel; plug the drive into archua.
3. **Route 2 only — the mac copy is now the truth; put it back before anything starts:**
   ```bash
   systemctl --user stop voice-agent          # ensure nothing races the copy (it's disabled, but be explicit)
   sudo field-personal unlock                 # mounts the volume (also restarts the service —
   systemctl --user stop voice-agent          #  stop it again before syncing)
   rsync -a --delete /Volumes/FieldPersonal/ /mnt/field-personal/   # mac copy → the LUKS volume
   field-personal verify
   ```
   (Get the mac copy across via the carried stick or a fresh `backup-file` made on the mac.
   Then wipe the APFS copy — the volume is the body again.)
4. **Route 1 (and Route 2 after step 3):** bring archua back up:
   ```bash
   sudo field-personal unlock                 # if not already from step 3
   systemctl --user enable --now voice-agent
   systemctl --user start timer-runner        # if stopped in §0.4
   field-personal status
   ```
5. Smoke: send a message at the home origin; confirm `agentc.chu` serves again (ngrok sidecar
   up); take a fresh `field-personal backup`.

---

## Failure modes to respect

- **Split-brain** — the only way to corrupt the vat with this procedure is to skip a "stop"
  step. Two live instances = clobbered last-write-wins chats, double-fired scheduled agents, and
  purse double-spend. V1 of `designs/vat-affinity.md` turns this rule into a mechanism (live
  lease + refusal); until then it is YOUR rule.
- **Route 2 without the copy-back** — running at home against the drive after camp changes lived
  only on the APFS copy silently discards camp state. If in doubt, `field-personal verify` +
  compare mtimes under `state/voice-agent/` before starting the home service.
- **Lost drive at camp** — the friky `backup` (ciphertext partition image) is the spare body;
  restoring it is a home operation. The gpg `backup-file` you carry is the camp-side fallback
  (Route 2 from it directly).
