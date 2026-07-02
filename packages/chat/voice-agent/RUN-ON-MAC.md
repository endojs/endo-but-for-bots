# RUN-ON-MAC — Agent C on the M1 MacBook Pro (DWeb Camp, Route 2)

**This is the definitive guide for the route dan chose (2026-07-01): Route 2 of
`VAT-MIGRATION.md`** — `field-personal backup-file` (gpg) on archua → decrypt onto an
**encrypted APFS volume** on the M1 → run natively via `FIELD_PERSONAL_ROOT`. Read
`VAT-MIGRATION.md` for the design + the one law; this file is the follow-along.

> **The one law (V0):** never run two live instances of the same vat. Stop + **disable**
> archua's service before the mac boots the vat, and stop the mac before archua gets it back.
> The top failure mode is archua rebooting at home and restarting the service while the vat is
> forked onto the mac — `disable` is what prevents that.

The server is plain node ESM under SES; nothing in the serving path needs Linux. Every
host-specific path is behind an env seam with archua-identical defaults.

---

## 0 — On archua, before leaving

Follow `VAT-MIGRATION.md` §0 (make current → back up → stop). The short form:

```bash
cd ~/endo-bfb-llm/packages/chat/voice-agent
./field-personal status
./field-personal migrate && ./field-personal verify
./field-personal backup        # spare body → friky (ciphertext)
./field-personal backup-file   # gpg tar — THE copy the mac opens. It lands on friky:
                               #   /mnt/user/dan/backups/field-personal/field-personal-<stamp>.tar.zst.gpg
                               # COPY IT to the drive's plaintext partition / a USB you carry:
                               #   scp root@192.168.50.74:/mnt/user/dan/backups/field-personal/field-personal-<stamp>.tar.zst.gpg /run/media/dan/<stick>/
systemctl --user stop voice-agent
systemctl --user disable voice-agent      # ← the "archua must not restart while the vat is forked" guard
```

Sidecars: scheduled agents travel with the vat (their store is on the volume); the host-local
`timer-runner` stays home — stop it only if its `command` timers would misbehave vat-less
(`systemctl --user stop timer-runner`). `agentc.chu` is NOT re-pointed (public binding is
explicit-only); with the service stopped it serves nothing, which is correct.

**Also clone the source before leaving** — the gitea remote (`friky:3030` /
`ssh://gitea/archuabot/endo-but-for-bots.git`) is home-LAN only:

```bash
# on the mac, at home (or put a `git bundle` of field-preact on the carried drive):
git clone -b field-preact <reachable remote or bundle> ~/endo-bfb
```

## 1 — On the M1: prerequisites

```bash
# Homebrew (brew.sh), then:
brew install node gnupg zstd            # node ≥ 22 (nvm works too); gpg+zstd decode the backup
corepack enable
cd ~/endo-bfb && npx corepack yarn install
cd packages/chat/voice-agent && npx corepack yarn build:islands   # islands bundle isn't committed
```

## 2 — Encrypted APFS volume + restore the vat body

**Recommended: an encrypted APFS volume on the internal SSD** (dan's chosen route — no
sparsebundle file to manage; FileVault-grade at-rest encryption; prompts for its own passphrase
on mount).

Disk Utility clicks: open Disk Utility → View ▸ Show All Devices → select the internal **APFS
container** → Edit ▸ Add APFS Volume… → Name `FieldPersonal`, Format **APFS (Encrypted)** → set
the passphrase (yours only) → Add.

Or the one-liner (find the container with `diskutil list internal` — e.g. `disk3`):

```bash
diskutil apfs addVolume disk3 APFS FieldPersonal -stdinpassphrase   # types the passphrase on stdin
# later mounts: Finder prompts, or: diskutil apfs unlockVolume FieldPersonal
```

(Alternative, if a portable file-based volume is preferred: `./field-personal mac-init` creates
and attaches an encrypted sparsebundle via hdiutil and prints the same export line. Pick one;
this guide assumes the APFS volume.)

Restore the backup onto it (**the format is tar | zstd | gpg**, so decode in that order):

```bash
gpg -d /Volumes/<stick>/field-personal-<stamp>.tar.zst.gpg | zstd -d | tar -x -C /Volumes/FieldPersonal
ls /Volumes/FieldPersonal    # → config/ state/ vault/ personal.json env
```

`personal.json` + `config/root.swiss` on the volume are what flip the service into personal
mode; the `env` file (the volume-local key subset) is found automatically — with
`FIELD_PERSONAL_ROOT` set, the key readers' fallback (`HOST_ENV_FILE`) defaults to
`<volume>/env`, so ANTHROPIC/OPENROUTER/HA keys need no extra sourcing.

## 3 — The env file

`~/.config/field-agent/field.env` (simple `KEY=VALUE`; `scripts/field-up.mjs` loads it, real
env wins over the file):

```bash
FIELD_PERSONAL_ROOT=/Volumes/FieldPersonal
FIELD_INSTANCE=dans-macbook
BIND=127.0.0.1                 # server.mjs's default BIND is archua's tailnet IP — fails on the mac
FIELD_LOCKDOWN=1               # matches the live archua unit (confined-fork rendering)
PUBLIC_BASE_URL=https://<mac-name>.taildd002.ts.net   # see tailscale serve below

# LLM — pick one:
#  with internet: leave AGENT_LLM unset and select an anthropic:<model> / openrouter:<slug>
#  in the provider menu (keys come from the volume's env file), or set a direct endpoint;
#  offline camp: a local OpenAI-compatible server —
#    ollama:     AGENT_LLM=http://127.0.0.1:11434/v1/chat/completions
#    llama.cpp:  AGENT_LLM=http://127.0.0.1:8080/v1/chat/completions
#AGENT_LLM=http://127.0.0.1:11434/v1/chat/completions

# STT — default points at tinix (unreachable). Local whisper server exposing OpenAI-style
# /v1/audio/transcriptions (e.g. speaches / faster-whisper-server), or leave unset:
# voice input degrades cleanly, typed chat is unaffected.
#STT_URL=http://127.0.0.1:8000/v1/audio/transcriptions
```

Optional seams (archua-identical defaults): `HOST_ENV_FILE`, `GPU_IMG_GEN` (absent → the
`images` power reports itself unavailable), `PLAYWRIGHT_CORE` + `FIELD_CHROMIUM` (browser power;
darwin default is `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`; the Linux
LD_LIBRARY_PATH shim is never applied on darwin), `FEED_MJS`, `MACHINES_FILE`.

**GPU-box endpoints (the tinix family), if you stand any of them up at camp.** `field-config.mjs`
centralizes them (the PORT-6 `ENDPOINTS` seam); each keeps its existing env var. Set `TINIX_HOST` to
relocate the whole box in one shot (gemma-LLM, whisper-STT, ComfyUI, diarizer all derive from it), or
override one at a time: `AGENT_LLM`, `STT_URL`, `COMFY_URL` (the ComfyUI base — the `images`/inpaint
power's abort/interrupt reads it), `MEETING_DIARIZE_URL`. Left unset at camp they point at the
home-LAN GPU box (unreachable off-tailnet) and degrade cleanly per §"What degrades".

**Home-rooted worktree/Blacksmith seams** (needed only if you use the self-editing / dev-agent roles at
camp — else ignore):

- `FIELD_AGENT_WORKTREE_REPO` — the git repo the worktree/Blacksmith roles clone worktrees FROM. On
  archua this is the live `~/endo-bfb-llm` checkout; on the mac point it at wherever you cloned
  `field-preact` (`~/endo-bfb` per §0). If the clone basename differs from archua's, this is the seam
  that reconciles it.
- `FIELD_AGENT_GIT_COMMON` — the shared `.git` common-dir the worktrees attach to (the
  `git worktree add` parent). Defaults alongside the worktree repo; set it only if you keep the
  object store somewhere other than the repo's own `.git`.
- `COMFY_URL` — see the GPU-box paragraph above (the ComfyUI base for the inpaint/images abort path
  that today has no per-call override in `agent-caps.mjs`).

**Clone-basename note (`endo-bfb` vs `endo-bfb-llm`).** archua runs the LIVE service from the worktree
checkout named **`endo-bfb-llm`** (branch `field-preact`); the guide above clones the source to
**`~/endo-bfb`**. That basename difference is fine for *serving* (nothing hardcodes the repo name in the
serving path), but the worktree/Blacksmith roles resolve their repo via `FIELD_AGENT_WORKTREE_REPO` — so
if you use those roles, set it to your actual clone path (`~/endo-bfb`) rather than assuming the archua
`endo-bfb-llm` name.

**What degrades with no bwrap.** macOS has no `bwrap`. The worktree/Blacksmith (dev-agent) roles then
fall back to a **cwd-jail** (a working-directory confinement in-process) — *not* a kernel sandbox. It
still scopes file paths, but a determined program is not kernel-isolated the way it is on archua. Treat
the self-editing/dev roles as lower-assurance at camp; if you don't need them, don't employ them there.

> **iroh dial (PORT-2).** The peer-redemption / iroh transport uses the native `@number0/iroh` addon. A
> `darwin-arm64` prebuild **is** published (`@number0/iroh-darwin-arm64@1.0.0`, os=darwin cpu=arm64), so
> `yarn install` on the M1 should fetch it automatically — but it's a lazy+optional dep, so **verify at
> install time** that it actually loaded (`node -e "require('@number0/iroh')"` in the ocapn-noise package)
> before relying on peer-redemption; if it didn't, iroh dial is unavailable (the rest of the app is
> unaffected).

**Secure context for the mic:** `getUserMedia` needs HTTPS. `tailscale serve` works the same on
macOS (Tailscale.app or `brew install tailscale`):

```bash
tailscale serve --bg http://127.0.0.1:8778
# → https://<mac-name>.taildd002.ts.net  — use it as PUBLIC_BASE_URL above
```

## 4 — First boot

```bash
cd ~/endo-bfb/packages/chat/voice-agent
node scripts/field-up.mjs ~/.config/field-agent/field.env
```

Boot log must show `instance: dans-macbook | field mode: personal | personal-root:
/Volumes/FieldPersonal …` and `field agent on http://127.0.0.1:8778`.

## 5 — launchd (supervised, survives reboot)

Templates in `deploy/launchd/`. Install both (voice-agent + timer-runner; the timer-runner
plist runs the **in-repo** `packages/chat/capture/timer-runner.mjs`):

```bash
cd ~/endo-bfb/packages/chat/voice-agent
for p in com.field.voice-agent com.field.timer-runner; do
  sed -e "s#/PATH/TO/REPO#$HOME/endo-bfb#g" \
      -e "s#/PATH/TO/NODE#$(command -v node)#g" \
      -e "s#/YOUR/HOME#$HOME#g" \
      deploy/launchd/$p.plist > ~/Library/LaunchAgents/$p.plist
done
mkdir -p ~/Library/Logs/field
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.field.voice-agent.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.field.timer-runner.plist
# restart: launchctl kickstart -k gui/$(id -u)/com.field.voice-agent
# remove:  launchctl bootout   gui/$(id -u)/com.field.voice-agent
```

`RunAtLoad` + `KeepAlive` mirror systemd's `Restart=always`; logs in `~/Library/Logs/field/`.
Note: after a mac reboot the APFS volume needs its passphrase before the service can enter
personal mode — unlock it (Finder / `diskutil apfs unlockVolume FieldPersonal`), then
`launchctl kickstart -k gui/$(id -u)/com.field.voice-agent`.

## 6 — Verify checklist

- [ ] `curl -s http://127.0.0.1:8778/powers | head -c 200` → JSON with
      `"instance":"dans-macbook","mode":"personal"`.
- [ ] Open `https://<mac-name>.taildd002.ts.net` — shell loads.
- [ ] **Re-present your cap link once** (from the password manager / carried QR — never print
      `root.swiss`): the browser's remembered cap is per-**origin** localStorage, and this is a
      new origin. After that it sticks; existing chats load.
- [ ] A chat turn completes (proves the AGENT_LLM path).
- [ ] Scheduled agents are visible (the `#sched=` link / ask the agent to list scheduled
      agents) — they travel with the vat and now fire HERE.
- [ ] Mic works on the tailscale-serve HTTPS origin (secure-context check).

## 7 — At camp, daily

The APFS copy is now the **only** live body; the carried gpg file is its only safety net. Once
a day (mac-side `backup-file` equivalent — same tar|zstd|gpg format):

```bash
tar -C /Volumes/FieldPersonal --exclude=./lost+found -cf - . | zstd -T0 -q \
  | gpg --symmetric --cipher-algo AES256 -o /Volumes/<stick>/field-personal-$(date +%Y%m%d-%H%M%S).tar.zst.gpg
```

## 8 — Return (mac → archua)

`VAT-MIGRATION.md` §3 is the authority. The order that matters: **stop the mac instance first**
(`launchctl bootout gui/$(id -u)/com.field.voice-agent`; `tailscale serve reset`), carry the
freshest backup home, **rsync/restore the mac copy onto the archua LUKS volume BEFORE
re-enabling voice-agent**, `field-personal verify`, then `systemctl --user enable --now
voice-agent` (+ `start timer-runner` if stopped). Then wipe the APFS copy — the drive is the
body again. Skipping the copy-back silently discards everything that happened at camp.

## What degrades at camp (env-off; nothing blocks boot)

tinix GPU (images power, gemma default LLM + vision, whisper STT), Home Assistant, the
`agent-*` personas/machines roster, gitea component sync (`COMPONENT_GIT_REMOTE` unset → off),
feed/ntfy/friky extras, email send — each reports unconfigured/unavailable with a clear error;
chat keeps working. If camp internet + tailscale come up, the tailnet-reachable ones return.
