# Familiar Preliminary Release

| | |
|---|---|
| **Created** | 2026-05-12 |
| **Updated** | 2026-08-31 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Proposed |
| **Source** | Issue [#229](https://github.com/endojs/endo-but-for-bots/issues/229) |

## What is the problem being solved?

The maintainer has asked, in
[issue #229](https://github.com/endojs/endo-but-for-bots/issues/229):

> Please propose a plan for a preliminary release of the Familiar,
> identifying gaps between the project status and a minimum viable
> release.
> The minimum viable release must at least have the `lal` agent
> integrated.
> It must be stand-alone and not rely on any developer tooling.
> Material like the `lal` "Primer" need to be bundled by whatever
> means.
> It may fall to the `lal` code to carry the Primer and inject it
> into the CAS on initialization instead of relying on the setup
> script.

The unmistakable goal is a downloadable Familiar that a
non-developer can install on their own machine, launch, point at an
LLM provider, and use to converse with the bundled `lal` agent.
A new user must not need a checkout of `endojs/endo`, a Yarn
install, a `corepack` activation, an `electron-forge` invocation,
or any other developer tool on the host that runs the application.

This document audits the present state of `packages/familiar/`,
catalogs the gaps, and proposes a phased plan with a clear
minimum-viable-release (MVR) scope.

## Status quo

The Familiar's build pipeline is `node scripts/build.mjs`, which
runs six steps:

1. `yarn workspace @endo/chat build` (vite renderer build).
2. `scripts/bundle.mjs` (esbuild CJS bundles for the daemon, CLI,
   worker, lal setup, lal agent, plus the Electron main).
3. `scripts/download-node.mjs` (download a Node binary from
   `nodejs.org/dist/<version>/`).
4. `scripts/prepare-package.mjs` (copy the right Node binary and
   chat dist into the package).
5. `scripts/package-app.mjs` (`@electron/packager` produces a
   `.app` / `.exe` / linux directory under `out/Familiar-<plat>-<arch>/`).
6. `scripts/make-distributables.mjs` (DMG on macOS, zip on every
   platform; opt out via `--app-only`).

The relevant supporting designs already landed:

- [`familiar-electron-shell`](familiar-electron-shell.md):
  daemon-manager, window, menu, IPC, `localhttp://`, navigation
  guard, exfiltration defenses.
- [`familiar-daemon-bundling`](familiar-daemon-bundling.md):
  esbuild CJS bundles for daemon, worker, CLI, plus the embedded
  Node binary.
- [`familiar-bundled-agents`](familiar-bundled-agents.md): `lal`
  setup bundle and agent bundle inside `bundles/`.
  The daemon's `ENDO_EXTRA` mechanism (in
  [`packages/daemon/src/manager-node.js`](../packages/daemon/src/manager-node.js))
  imports the bundled `endo-lal-setup.cjs` after the host is
  ready and runs its `main(host)`.
- [`lal-fae-form-provisioning`](lal-fae-form-provisioning.md):
  the agent sends a configuration form to the host inbox; the
  user supplies host, model, and auth token through Chat.

The agent already self-bundles the Primer.
`packages/lal/agent.js` (line 186 onward) does:

```js
const primerDirPath = new URL('./primer', import.meta.url).pathname;
const localPrimerTree = makeLocalTree(primerDirPath);
await E(agent).storeTree(localPrimerTree, 'lal-primer');
const primerTreeId = await E(agent).identify('lal-primer');
```

`scripts/bundle.mjs` already copies `packages/lal/primer/` to
`packages/familiar/bundles/primer/` so the bundled `agent.js`'s
`new URL('./primer', import.meta.url)` resolves under the packaged
`bundles/` directory.
The mechanism the issue body describes ("lal carries the Primer
and injects it into the CAS, the daemon's content-addressable
store, on initialization") is therefore already in place.
What remains is to verify it end to end in a fresh-install
configuration and to surface the rest of the gaps below.

The Familiar's `package.json` lists `electron` as both a runtime
dependency and a devDependency (Electron Forge needs it in
devDependencies for version detection; the runtime needs it as a
dependency).
The `dependencies` block today is:

```json
"dependencies": {
  "@endo/where": "workspace:^",
  "electron": "^43.3.0"
}
```

`@electron/packager` walks the dependency tree and only copies
files that pass `package-app.mjs`'s allowlist filter
(`/preload.js`, `/package.json`, `/bundles`, `/dist`, `/node`,
`/node.exe`).
That allowlist already excludes the entire `node_modules` tree
from the packaged app; the bundles are self-contained.

### What works today (assumed)

- The Electron app launches.
- The bundled daemon spawns under the embedded Node binary.
- The `lal` setup script provisions the manager guest.
- The agent sends a config form to the host inbox.
- The user fills in the form in Chat.
- The agent stores the Primer as a `readable-tree` in the daemon's
  CAS.
- Each spawned worker loop receives a `primer` reference.

### What does not work today (assumed gaps)

This audit identifies the discrepancies between the implemented
build pipeline and a downloadable preliminary release.
Each gap is itemized in the next section with severity, current
behavior, target behavior, and rough effort.

## Gaps

The gaps are numbered G1 through G16 below in audit order rather
than grouped under category headings.

Each gap's per-item block is the single source of truth for that
gap's status. Every one of G1 through G16 carries a `**Severity:**`
line (intrinsic impact), an `**MVR disposition:**` line (in scope
for MVR, deferred, or out of scope), and a `**Target:**` line
(target behavior); a gap whose disposition was set by a recorded
decision also carries a `**Resolved by:**` provenance line naming
that decision, and gaps that are simply in MVR scope by default omit
it. The `MVR: minimum to ship`, `Followups`, and `Out of scope for
this release` tables in the Phased plan are **derived views** for
scanning by phase, not independent records: on any scope change,
edit the per-gap block first and reconcile the summary tables to it.

The `**Effort:**` lines below sometimes name a **builder pass**, a
**designer pass**, or a **gardener pass**. These are dispatches to
the automated fleet that carries this design's follow-on work, not
distinct human milestones: a builder pass writes and lands the
implementation, a designer pass produces a companion design for an
under-specified area, and a gardener pass stands up recurring
automation. Where a line reads "builder-dispatched," the work is
scoped for such a dispatch rather than assumed to be hand-done.

### G1. Uncommitted bundles directory and a mandatory build

**Severity:** Blocker.
**MVR disposition:** In scope for MVR (confirm the existing release
workflow's artifacts and promote a per-PR build smoke).
**Current:** `packages/familiar/bundles/` and
`packages/familiar/binaries/` are absent from a fresh checkout
(they are build outputs).
The build pipeline in `scripts/build.mjs` calls
`yarn workspace @endo/chat build` and the bundle/download/prepare
scripts; producing a release artifact requires Yarn, the chat
package's full toolchain (vite + plugins), and the esbuild
binary.
**Target:** A release engineer runs `yarn workspace @endo/familiar
build:package` on a single CI host per target platform; the
output `out/make/Familiar-<version>-<plat>-<arch>.zip` (and the
DMG on macOS) is the artifact users download.
The user installs the artifact and never needs Yarn.
The `familiar-release.yml` workflow already wires this pipeline
into CI: it builds the bundles and chat dist, runs a per-platform
`make` matrix (macOS arm64 on `macos-14`, macOS x64 on `macos-13`,
Linux x64 on `ubuntu-latest`), and publishes a draft GitHub
Release with the artifacts attached.
It fires only on `workflow_dispatch` and `familiar-v*` tags, so
the remaining MVR step is confirming that release flow produces
installable per-platform artifacts end to end and (per Tier 0 in
the CI-verification section) promoting a build smoke onto the
per-PR gate, not authoring the workflow from scratch.
**Effort:** Day to confirm the existing workflow's artifacts
install cleanly; the release pipeline already exists, so no new
workflow is authored.

### G2. macOS code signing and notarization

**Severity:** Blocker (intrinsic impact: a non-developer cannot launch
the unsigned app without the workaround below).
**MVR disposition:** Deferred, with a documented workaround.
**Resolved by:** the maintainer's 2026-05-19 review pass, which
deferred notarization for MVR and shipped the documented `xattr`
workaround; the signing-identity setup that pass stages is recorded
under [Open questions](#open-questions) Q2 below.
(The `**Severity:**` line records intrinsic impact only; the
`**MVR disposition:**` and `**Resolved by:**` lines carry the scope
decision and its provenance, kept as separate fields throughout the
Gaps section so a reader triaging by impact is not reading a scope
decision folded into the severity rating.)
**Current:** `package-app.mjs` calls
`@electron/packager` without `osxSign` or `osxNotarize` options.
A user who downloads the resulting `.dmg` from a browser is
greeted with Gatekeeper's "this app is damaged" or "cannot verify
the developer" dialog and must run `xattr -d com.apple.quarantine`
on the bundle by hand.
A non-developer will not do this and will assume the app is
broken.
**Target:** The build eventually runs `osxSign` with a Developer ID
Application certificate and `osxNotarize` against an Apple ID
configured in the build environment; the DMG carries a notarized
ticket that Gatekeeper accepts on a user's machine without
prompts.
For MVR, skip the notarization integration.
The early user pool is small enough to accept the manual
`xattr -d com.apple.quarantine` workaround documented in the
README.
This is a deliberate, explicitly-acknowledged exception to the
problem statement's "no developer tool on the host" criterion:
the `xattr` invocation is a terminal command a non-developer
would not run unaided, so the instruction must both spell out the
exact command and state plainly that it is a known first-run
speed-bump that notarization (deferred here) removes.
The Gatekeeper dialog fires the instant the user double-clicks
(before the user has any reason to have opened a repo README,
which a DMG double-click does not route them to).
The instruction must therefore be discoverable *at the point of
friction*, not only in `packages/familiar/README.md`.
It must appear on the GitHub release / download page the user
actually fetches the DMG from, and ideally in the DMG's own
background/instructions image, so the user meets the workaround
where the failure happens.
Until notarization lands, the Gatekeeper dialog is the app's only
signal, so the documented workaround is the only way past it.
The certificate-acquisition process is tracked in a separate
issue (see G3 for the parallel ask on Windows; the macOS issue
covers the Developer ID Application certificate and the
App Store Connect API key administratively).
**Effort:** Multi-day to multi-week when undertaken, dominated by the
administrative cost of obtaining a Developer ID and an App
Store Connect API key, plus debugging the entitlements file
that notarization will demand.
The Electron docs describe the mechanism; the work is
configuration, not code.

### G3. Windows code signing

**Severity:** Important (Windows).
**MVR disposition:** Out of scope (MVR targets macOS and Linux x64 only).
**Resolved by:** the 2026-05-19 review pass.
**Current:** No Windows signing.
A user double-clicking `Familiar-<version>-win32-x64.zip` and the
extracted `Familiar.exe` triggers SmartScreen's "unrecognized
publisher" dialog.
**Target:** Sign the exe with an EV (or OV) certificate; the EV
certificate yields immediate SmartScreen reputation, while the OV
certificate accumulates reputation over downloads.
The certificate-acquisition process is tracked in a separate
issue (see the Followups section below) that records the steps for
beginning the EV / OV certificate process so that a future
maintainer can pick it up.
**Effort:** Multi-week when undertaken, dominated by certificate
acquisition (an EV cert ships on a hardware token); the in-tree
script change to add `signtool` invocation under
`make-distributables.mjs` is a day.

### G4. Linux distribution shape

**Severity:** Important (Linux).
**MVR disposition:** Ship the existing `.zip` plus README; Flatpak
chosen for followups, other formats deferred.
**Resolved by:** the 2026-05-19 review pass.
**Note:** the intrinsic-impact rating above is Important, but the
*launch-path* risk this gap describes is elevated downstream:
[Platform coverage of the runtime
tiers](#platform-coverage-of-the-runtime-tiers) characterizes the
same `chrome-sandbox`/userns failure mode as an "acknowledged
Blocker-adjacent risk on the Linux launch path" precisely because
it is a named, previously-identified failure mode rather than a
generic display-bound residual. A reader triaging by the Severity
line alone should carry that elevation, not stop at "Important".
**Current:** `make-distributables.mjs` emits a `.zip`.
A Linux user who unzips it gets a directory of files including
the `Familiar` ELF binary, `chrome-sandbox` (which must have
`chmod 4755` applied and be chowned to root for Chromium's suid
sandbox to work, otherwise Electron falls back to `--no-sandbox`
or refuses to launch), and a tree of Chromium runtime files.
Whether the suid setup is actually required depends on the host,
and the host landscape is not uniform. Recent upstream kernels
enable unprivileged user namespaces by default (`CONFIG_USER_NS`),
which in principle lets Chromium sandbox without the setuid helper
and without root; but several major desktop distributions restrict
unprivileged userns above the kernel layer regardless of that
default. Ubuntu 23.10 and later (including the 24.04 LTS most
early adopters will run) mediate unprivileged userns through
AppArmor, so a raw extracted binary with no registered AppArmor
profile (exactly the `.zip`-and-unzip shape this design ships)
hits `clone(CLONE_NEWUSER): Operation not permitted` and still
needs either the setuid `chown root` helper or `--no-sandbox`;
Debian has historically shipped `kernel.unprivileged_userns_clone=0`
for the same reason. So "the kernel default on recent lines" is a
true statement about upstream `CONFIG_USER_NS`, but it is not the
same claim as "works out of the box on a desktop install."
The README documentation must therefore verify, per target distro,
whether the userns path already works before presenting the setuid
`chown root` step as an unavoidable requirement, so the
"needs `sudo`" framing is not overstated where the kernel already
provides the sandbox, while stating plainly that on Ubuntu, the
most likely target, the setuid path is the expected one.
**Target:** Ship a Flatpak manifest, with documentation for the
chrome-sandbox setup.
A separate builder pass will propose the Flatpak pipeline (see
the Followups section below).
The other packaging systems (`.AppImage`, `.deb`, `.rpm`,
`.tar.gz`) are deferred.
The MVR position can defer downstream packaging and
ship the existing `.zip` plus a brief README; the followups
phase ships Flatpak.
Because this is a launch-blocking OS-gate remediation of the same
class the design escalates for macOS Gatekeeper (G2), the
`chrome-sandbox` setup instruction must be delivered *at the point
of friction* the same way, not only in `packages/familiar/README.md`:
it must appear on the GitHub release / download page next to the
Linux `.zip` artifact the user actually fetches, so a user who
unzips and double-clicks without ever opening a README still meets
the workaround where the sandbox failure happens.
Because the Linux launch path ships with no CI launch evidence at
MVR (Tier 2 stays macOS-only; see [Platform coverage of the
runtime tiers](#platform-coverage-of-the-runtime-tiers)), MVR also
carries a cheap human backstop for this Blocker-adjacent risk: the
release engineer manually launches the built Linux `.app` once on
**Ubuntu** (the distro whose AppArmor userns mediation makes it the
most likely to exercise the `chrome-sandbox` failure path above,
per the Current section) and confirms it reaches the
converse-with-`lal` end state before tagging a release, until a
Linux Tier 2 GUI smoke (under `xvfb`) lands in followups and
replaces the manual step.
**Effort:** Day for the README plus the point-of-friction
download-page note and the pre-tag manual launch check; week for the
Flatpak manifest (builder-dispatched).

### G5. Bundled Node binary version pin policy

**Severity:** Important.
**MVR disposition:** In scope for MVR (document the pin policy; the
pin bump itself is done); the automated LTS motion-sensing mechanism
is deferred to followups.
**Current:** `scripts/download-node.mjs` defaults to
`v22.22.3` (a string literal in the script); the pin was advanced
from `v20.18.1` to a currently-supported LTS in 2026-05 per
maintainer direction (2026-05-19), so the version-advance itself
is already done.
What is still missing is a documented response cadence: a
vulnerability disclosure against the embedded Node line or a Node
EOL event has no written policy.
**Target:** A documented policy in the package README for keeping
the embedded Node current with a supported LTS.
The release engineer pins to the latest LTS in each release
cycle and ships a security release if a CVE affecting the
embedded Node lands.
A builder pass advances the current pin to the working LTS
(see the Followups section below).
A gardener pass proposes an automated mechanism for sensing
motion on the Node.js LTS supported-versions window and
maintaining an upgrade PR (against this version and the CI
matrix) as that window shifts (see the Followups section below).
**Effort:** Day (write the policy and the release-cycle
checklist); day for the LTS pin bump; multi-day for the
gardener-designed motion-sensing mechanism.

### G6. Auto-update channel

**Severity:** Important.
**MVR disposition:** Out of scope (users re-download on announcement).
**Resolved by:** the 2026-05-19 review pass (Open Question 6, in
the Open questions section below).
**Current:** None.
A user who installs Familiar 0.1.0 will still be running 0.1.0
when 0.2.0 ships unless they re-download.
**Target:** `electron-updater` against an S3 bucket (or GitHub
Releases) with a public update manifest, signature-verified
against the same code-signing certificate as G2/G3.
For MVR, defer auto-update entirely (see Open Question 6, below).
Users re-download when a new release is announced; the GitHub
Releases distribution channel (see Open Question 1, below) is the
publication venue.
**Effort:** Multi-day when revisited; signature verification
depends on G2 and G3 being in place first.

### G7. Application icon and metadata for `assets/icon`

**Severity:** Important.
**MVR disposition:** In scope for MVR (confirm the icon assets
resolve per platform); the projection automation is deferred to
followups.
**Current:** `scripts/package-app.mjs` references
`assets/icon` and (for DMG) `assets/icon.icns`.
The `assets/` directory is present in the repo; whether the
icon assets are correctly sized and exported per platform is
release-blocking but not part of code review.
**Target:** Verify (and, if absent, generate via
`scripts/generate-icons.sh`) the `.icns`, `.ico`, and `.png`
sets and confirm the macOS Info.plist `CFBundleIconFile`
resolution.
The `package.json` has no `productName` or
`CFBundleDisplayName`; the packager defaults to "Familiar"
which is acceptable.
A builder pass improves the automation for projecting these
file formats from the source icon (see the Followups section below).
Where the projection is platform-specific, the built artifact
may be checked in, with automation that runs in a CI
environment using platform-specific tool kits to refresh it.
**Effort:** Day for the projection automation (builder-dispatched).

### G8. Dev-mode `endo` CLI bundle in the production runtime path

**Severity:** Important.
**MVR disposition:** Deferred (ship the CLI bundle as-is for MVR).
**Resolved by:** the 2026-05-19 review pass.
**Current:**
[`src/daemon-manager.js`](../packages/familiar/src/daemon-manager.js)
calls `runEndoCommand(['stop'])` and `['purge']` from menu
actions for "Restart Daemon" and "Purge Daemon".
These spawn the bundled `endo-cli.cjs` as a subprocess.
That bundle is shipped (it is in the `package-app.mjs`
allowlist), so this works in the packaged build, but it
pulls in roughly 20% of the daemon's transitive deps a
second time inside `endo-cli.cjs`.
**Target:** The MVR can ship the CLI bundle as-is.
A followup folds stop/purge into a direct CapTP message from
the Electron main, removing the need to bundle the CLI in the
production app.
A builder pass implements the consolidated solution so the
reviewable material exists (see the Followups section below), even though
the consolidation itself is deferred past MVR.
**Effort:** Day for the followup; zero for MVR.

### G9. Gateway port collision

**Severity:** Important.
**MVR disposition:** In scope for MVR (README note plus an in-app
daemon-start-failure dialog); the OS-assigned fallback port and the
host-wide Gateway packaging story are deferred to followups and
out of MVR scope respectively.
**Current:** The daemon binds the gateway on port `8920` by
default
([`src/daemon-manager.js`](../packages/familiar/src/daemon-manager.js)
(line 296 onward)).
A user who already runs an Endo daemon (as a developer might)
will see the Familiar's daemon detect the existing one and join
it on the Unix socket, which is the graceful case.
The failing case is different: a user who has an unrelated
process bound to TCP `8920` will see the daemon fail to start.
**Target:** For MVR, document the collision case in the
README; the Familiar already detects the existing-daemon
case and joins the running daemon.
Because the audience will not consult logs or a README to
diagnose a blank or failed launch, MVR also surfaces the failure
in-app: a daemon that fails to start shows a dialog naming the
cause (e.g., "port `8920` already in use") and the log-file path,
rather than silently presenting a dead window.
This dialog is new UI/IPC work (a failure surface wired to
daemon-start-failure detection), not a documentation task, and its
implementation cost is the substantive part of this gap's MVR
effort; it is independent of the longer-term gateway direction
below, which a later implementer can adopt without it.
For followups, align with the shared-host-gateway direction
described in [`gateway-package`](gateway-package.md): the Familiar
participates as a per-user daemon that connects to a
host-wide Gateway service rather than terminating external
HTTP itself.
Package a gateway daemon (or system service) for Windows,
macOS, and Linux that is consistent with each platform's local
idioms for installing and running services; this would
typically be installed by an administrator on behalf of all
users.
Provide a fallback for the single-user case: a Familiar-managed
gateway listening on an ephemeral OS-assigned port (the
existing `127.0.0.1:0` posture, with the assigned port
persisted).
Because that same long-term fix routes weblets (the Familiar's
embedded per-site web views, each otherwise served from its own
HTTP port) through the shared Gateway rather than a
Familiar-terminated HTTP port, the per-port weblet variant is
dropped as part of the same change:
the Familiar weblet story collapses to a single flavor, namely
Familiar iframe weblets served through the custom protocol
scheme (`localhttp://`) and HTTP virtual-host proxy on the
shared gateway, per
[`familiar-localhttp-protocol`](familiar-localhttp-protocol.md)
and
[`familiar-unified-weblet-server`](familiar-unified-weblet-server.md).
**Effort:** Day to multi-day for the README plus the in-app
daemon-start-failure dialog (the dialog is the bulk of it, being
new UI/IPC rather than documentation); multi-day for the
OS-assigned fallback; multi-week to multi-month for the host-wide
Gateway packaging story (tracked under
[`gateway-package`](gateway-package.md), out of MVR scope).

### G10. State directory shape on a fresh install

**Severity:** Nice-to-have.
**MVR disposition:** Deferred (leftover state directory acceptable for MVR).
**Resolved by:** the 2026-05-19 review pass.
**Current:** The Familiar uses `@endo/where` to resolve
`whereEndoState`, which on Linux is `~/.local/state/endo/`,
on macOS `~/Library/Application Support/endo/`, on Windows
`%LOCALAPPDATA%\endo\State\`.
A user who installs Familiar, uses it, then uninstalls, will
leave behind their state directory; the Purge menu item
deletes the daemon-managed contents but the directory itself
persists.
**Target:** Acceptable for MVR.
A first-run dialog could explain where state lives so the user
can delete it after uninstall; defer to followups.
Cleanup may fall out naturally from an uninstall hook in the
platform-specific packaging once that lands, in which case the
explicit dialog becomes unnecessary.
**Effort:** Day for the dialog if pursued; zero if the
packaging uninstall hook handles it.

### G11. LLM credential entry UX

**Severity:** Nice-to-have.
**MVR disposition:** Ship the current form flow as-is for MVR.
**Resolved by:** the 2026-05-19 review pass.
**Current:** The user supplies their LLM provider host, model
name, and auth token through a form sent to their inbox by the
agent.
The form's `authToken` field is marked `secret: true` and the
Chat UI honors the secret marker by masking the input.
On submission, the value is stored in the daemon's CAS.
**Target:** The MVR can ship this flow as-is; it is functional
and user-tested by the maintainer (reported in the 2026-05-19
review pass; treated as an informal maintainer confirmation rather
than a CI-verified claim, unlike the "What works today (assumed)"
list and G16, which name their verification mechanism).
The followup "test connection" button is deferred.

One error-visibility residual is worth naming with the same
acknowledged-risk discipline this plan applies to the daemon-start
failure (G9) and the Linux launch path: the single most probable
failure at the MVR exit criterion is a *first turn* that fails
because the user mistyped the provider host, token, or model, and
MVR ships no pre-flight validation for it (the deferred "test
connection" button is exactly what would catch a bad credential
before the first send). At MVR a bad credential therefore surfaces
only as a failed turn in the Chat transcript, and no CI tier drives
a failed turn through the rendered UI (Tier 1's assertions cover the
success path for both provider shapes; see the mock-gateway table),
so there is no verified claim that the failure renders legibly. MVR
knowingly carries this as an **acknowledged residual on the
credential-entry path**, in the same class as the Linux-launch and
real-UI exit-criterion residuals; closing it means the followup
"test connection" pre-flight plus a Tier-1 assertion for a failed
turn, not an MVR gate.
**Effort:** Zero for MVR; day for the followup test button if
revisited.

### G12. Outbound network policy

**Severity:** Important.
**MVR disposition:** Out of scope for MVR (the unconfined agent is
accepted; outbound HTTP confinement is tracked under Milestone 1).
**Current:** The bundled `lal` agent fetches against
`https://api.anthropic.com/`, `https://api.openai.com/`,
`http://localhost:11434/v1/` (Ollama default), or whatever
host the user typed into the form.
The agent has unconfined `fetch` access (it is an unconfined
guest by construction).
**Target:** Acceptable for MVR; the agent runs with the user's
own machine privileges, unconfined (there is no containment
boundary around its network egress at MVR), and is trusted code
shipped by us.
A followup constrains outbound HTTP to the user-configured
LLM host plus a documented allowlist; this is the
[`endoclaw-network-fetch`](endoclaw-network-fetch.md) work
already on Milestone 1.
**Effort:** Zero for MVR; tracked under the existing design.

### G13. Telemetry, crash reporting, and error logs

**Severity:** Nice-to-have.
**MVR disposition:** In scope for MVR (rename the shell log and
document log locations); the opt-in crash/telemetry uploader is
deferred to followups, gated behind a designer pass.
**Current:** `src/logger.js` writes to `familiar.log` in the
Endo state directory; the daemon writes to `endo.log` in the
same directory.
There is no upload mechanism, no opt-in, and no UI for
"submit logs".
**Target:** For MVR, rename the Familiar-written log from
`familiar.log` to `familiar-shell.log` (in `src/logger.js`) so it
self-identifies against the daemon's `endo.log` by name alone,
rather than requiring a non-developer to learn a written selection
rule between two similarly-named siblings.
The daemon's `endo.log` keeps its name (it is the Endo daemon's
own convention, shared across every Endo host and not Familiar's to
rename), so the README still records the one remaining pairing
(`familiar-shell.log` covers the Electron shell and UI, `endo.log`
covers the daemon and agent; attach whichever matches the symptom,
or both when unsure), but the Familiar-side name now carries its
own role.
A followup adds an opt-in Sentry-style uploader; a designer
pass fleshes out the opt-in telemetry / crash-reporting shape
before any implementation work (see the Followups section below).
**Effort:** Day for the README; multi-week for the uploader
once the designer's shape is in hand.

### G14. Third-party license aggregation

**Severity:** Important.
**MVR disposition:** In scope for MVR (aggregate the LICENSE
notices into the bundle).
**Current:** The packaged app contains Electron, the Node
binary, the bundled SDK code (`@anthropic-ai/sdk`, `openai`,
`ollama`), and many transitive dependencies through the
esbuild bundles.
None of their licenses or notices are surfaced in the
packaged app.
**Target:** Aggregate the LICENSE files of every package
included in the bundles via an `oss-attribution-generator`
or `license-checker` step in `make-distributables.mjs`, and
ship the result as `LICENSE.third-party.txt` next to the
binary.
A builder pass implements the aggregation step (an MVR item; see
the `MVR: minimum to ship` table in the Phased plan below).
**Effort:** Day (builder-dispatched).

### G15. macOS arm64 vs x64 build matrix

**Severity:** Important (macOS).
**MVR disposition:** In scope for MVR, and already satisfied by the
release workflow's per-platform `make` matrix; the universal binary
via `@electron/universal` is deferred to followups.
**Current:** `package-app.mjs` runs with `arch: process.arch`,
so the build host's architecture is what the build emits.
A user on Apple Silicon needs the `arm64` build; an Intel Mac
user needs `x64`.
**Target:** The build runs on both architectures (or uses
universal binaries via `@electron/universal`) and the
distribution surface offers both.
A builder pass lands the multi-arch matrix (see the Followups
section below).
**Effort:** Day per CI host; multi-day for universal binaries
(builder-dispatched).

### G16. Unverified Primer-into-CAS path in the packaged build

**Severity:** Blocker.
**MVR disposition:** In scope for MVR (the Tier 0 build smoke and
the Tier 1 headless daemon smoke, gated per-PR).
**Current:** `agent.js` calls `new URL('./primer',
import.meta.url)`.
In the bundled `bundles/agent.js`, `import.meta.url` resolves
to a `file://` URL inside the packaged app, and the bundle
script copies `packages/lal/primer/` to
`bundles/primer/`.
This *should* work, but it has not been documented as a
verified end-to-end test.
**Target:** A smoke test step in CI: build the app, launch it
under a clean state directory, exercise the form, submit
config, observe the Primer tree appearing in the host
namespace and the worker loop receiving a `primer`
reference.
A builder pass adds the tests for this flow (an MVR item; see the
`MVR: minimum to ship` table in the Phased plan below).
The concrete CI mechanism (tiers, assertions, mock gateway, and
macOS-runner hazards) is in the
[Verifying the assumed-working chain in CI (macOS)](#verifying-the-assumed-working-chain-in-ci-macos)
section.
**Effort:** Day for the test scaffold (builder-dispatched).

## Primer-into-CAS migration

The issue body grants permission ("It may fall to the lal code
to carry the Primer and inject it into the CAS on initialization
instead of relying on the setup script").
The migration is **already implemented** in `agent.js`; this
section records the shape so future readers do not relitigate it.

### Current shape

The setup script
([`packages/lal/setup.js`](../packages/lal/setup.js)) provisions
the manager guest and launches the agent caplet.
It does **not** carry the Primer.

The agent caplet
([`packages/lal/agent.js`](../packages/lal/agent.js)) does carry
the Primer, after the form-loop initializes:

```js
const primerDirPath = new URL('./primer', import.meta.url).pathname;
const localPrimerTree = makeLocalTree(primerDirPath);
await E(agent).storeTree(localPrimerTree, 'lal-primer');
const primerTreeId = await E(agent).identify('lal-primer');
```

For each new sub-guest spawned in response to a form submission,
`provisionPrimer(guest)` does:

```js
if (!await E(guest).has('primer')) {
  await E(guest).storeIdentifier('primer', primerTreeId);
}
```

The `bundles/primer/` copy in
[`scripts/bundle.mjs`](../packages/familiar/scripts/bundle.mjs)
(line 80 onward) ensures `import.meta.url` resolves to a
sibling directory in the packaged build.

### What this design adds

A CI smoke test (G16) that exercises the path in the packaged
build, plus a brief mention in the package README that the
Primer ships with the agent and lands in the user's CAS at
first form submission.

The setup script need not change.
The agent need not change.
The bundle script need not change.

## Verifying the assumed-working chain in CI (macOS)

The "What works today (assumed)" list above is a set of
unverified runtime claims.
The maintainer has asked for a plan to verify them in CI,
specifically on the macOS environment.
This section turns each assumption into a concrete CI check and
names the macOS-runner hazards the plan must design around.

### What already runs on macOS CI

`familiar-release.yml` already builds the bundles and chat dist
on `ubuntu-latest`, then runs a `make` matrix whose macOS cells
are `macos-14` (darwin arm64, the MVR primary) and `macos-13`
(darwin x64).
Those cells download the matching embedded Node binary, prepare
the package, and produce a `.dmg`.
That proves the *build* half of G1 and G15 on real macOS runners,
but only that the artifact packages.
It says nothing about whether the packaged app *runs*: the
workflow fires only on `workflow_dispatch` and `familiar-v*`
tags, and it never launches the result.
The seven assumptions are runtime claims, so the plan adds a
runtime tier on top of the existing build tier.

### Three verification tiers

The assumptions split by how much of the stack each one needs,
so the plan is tiered from cheapest and most deterministic to
most expensive and most display-dependent.

**Tier 0: build smoke (extends what exists).**
Promote a build-only job to per-PR CI, running on `macos-14`.
The path filter must cover every package the gated build pipeline
touches, not only the packages the gaps name: `packages/familiar/**`,
`packages/lal/**`, `packages/daemon/**`, and `packages/chat/**`
(the vite renderer, whose `yarn workspace @endo/chat build` is the
pipeline's very first step, so a chat regression that breaks the
bundled renderer would otherwise slip past this Blocker-severity
gate).
It runs the existing bundle, download, prepare, and make steps
and asserts the `.app` and `.dmg` are produced.
This catches a familiar-touching PR that breaks packaging on
macOS arm64 without waiting for a release tag.
It covers no runtime assumption on its own; it is the
precondition the next two tiers build on.

**Tier 1: headless daemon smoke (the deterministic core).**
Six of the seven assumptions are daemon-level and need no
window.
Each Tier 1 runner first runs the Tier-0 build steps for its own
platform to produce that platform's package (the packaged artifact
is platform-specific, so a Tier 1 cell on `macos-13` or
`ubuntu-latest` cannot reuse the `macos-14` per-PR Tier 0 build; it
builds its own, and the per-runner build cost is part of Tier 1's
budget on those two cells).
It then launches the freshly-built packaged daemon bundle under the
embedded Node binary, against a clean state directory, and drives
the form path through the daemon's CapTP API instead of the Chat
renderer.
Point the agent at an in-process mock LLM gateway (see below) so
no live credentials or public network sit in the assertion path.
One assertion per assumption, plus a final assertion for the
MVR exit criterion itself (that the user can exchange a message
with `lal`), which the mock gateway's one-turn surface exists to
support:

| Assumption | CI assertion |
|---|---|
| Bundled daemon spawns under embedded Node | the daemon process starts under the bundled `node` and answers on its endpoint |
| `lal` setup provisions the manager guest | `setup.js` `main(host)` completes and the manager guest resolves |
| Agent sends a config form to the host inbox | a form message appears in the host inbox |
| (stand-in for) user fills the form in Chat | submit the form over CapTP with the mock gateway's host, model, and token, plus the per-shape endpoint-redirect seam that actually points the request at the mock (`OLLAMA_HOST` for the Ollama shape, the new `baseUrl` override for the registry-provider shape — see [The mock LLM gateway](#the-mock-llm-gateway)) |
| Agent stores the Primer as a `readable-tree` in CAS | `E(host).identify('lal-primer')` resolves to a readable-tree |
| Each spawned worker loop receives a `primer` reference | a spawned worker guest has a `primer` reference |
| (the MVR exit criterion) the user exchanges a message with `lal` | send one message over CapTP; the agent completes a turn against the mock gateway and a reply appears in the host inbox |

This is G16 made concrete and given a macOS runner.
It is deterministic (no display, no live model) and is the tier
worth gating per-PR, because it covers six assumptions at once.

**Tier 2: GUI launch smoke (the one display-bound claim).**
Only "the Electron app launches" needs the real window, plus the
renderer reaching `localhttp://` and the navigation guard
holding.
macOS runners expose a WindowServer, so unlike headless Linux
(which needs `xvfb`) the packaged `.app` can launch with a real
window.
Drive it with Playwright's Electron runner
(`_electron.launch({ executablePath: <binary inside the .app> })`),
asserting the `BrowserWindow` opens, the renderer reaches its
`localhttp://` ready state, and an off-origin navigation is
rejected by the guard.
Tier 2 is slower and more display-dependent, so it runs on
`familiar-release.yml` after `make` and on a nightly schedule,
not on the per-PR gate, until its flake rate is measured.

One residual is worth naming explicitly, with the same
acknowledged-risk discipline this plan applies to the Linux launch
path below: no tier drives the literal MVR exit criterion ("fills
in their LLM provider details, and exchanges messages with `lal`")
through the *rendered Chat UI*. Tier 1 exercises the exit criterion
over the daemon's CapTP API as a deliberate stand-in for the Chat
form-fill-and-send (so the assertion stays headless and
deterministic), and Tier 2 asserts only that the window opens, the
renderer reaches its `localhttp://` ready state, and the navigation
guard holds; it never drives a keystroke or a send through the
Chat surface. The form-fill-and-send path through the real renderer
is therefore covered by CapTP-level equivalence plus the
maintainer's informal hands-on confirmation (as with G11), not by a
CI real-UI assertion. Closing it fully means driving the Chat
renderer with Playwright inside Tier 2 (type into the form, submit,
assert a reply renders); that is followup work carried alongside
the Linux Tier 2 GUI smoke, not an MVR gate.

### The mock LLM gateway

The form provisioning
([`lal-fae-form-provisioning`](lal-fae-form-provisioning.md))
points the agent at an LLM provider host, model, and token.
The CI stand-in for "the user points it at a provider" is a tiny
HTTP server bound to `127.0.0.1` that speaks the minimal provider
surface the agent needs to complete one turn (or replays a
recorded fixture).
For the assertion path to stay off the public network and fully
deterministic — which is what makes Tier 1 gate-able — every
provider shape the smoke drives must have a seam that redirects its
outbound request endpoint to the mock's address. The two shapes G12
puts in scope do **not** share one seam today, and — a correction to
an earlier draft of this section that assumed "injecting the mock's
address as the form's `host` field" would redirect every shape — the
registry-provider shape has no such seam at all:

- **The `ollama/<id>` shape** already has a redirect seam.
  `resolveModel` (`@endo/agentry/harness`, re-exported from
  `packages/lal/model-resolution.js`) special-cases the `ollama/`
  prefix through `buildOllamaModel`, which reads an `OLLAMA_HOST`
  credential (default `http://127.0.0.1:11434`) and threads it into
  the pi-ai model's `baseUrl`. So the Tier-1 Ollama cell injects the
  mock's address as `OLLAMA_HOST` — a credential, **not** the form's
  `host` field — and its request path lands on the mock.
- **The registry-provider shape** (Anthropic, OpenAI, and the like,
  which carry a real bearer token) has **no** endpoint-redirect seam
  today, so the design must add one before Tier 1 can drive it
  offline. The form's `host` field becomes `LAL_HOST`, and
  `resolveModelString` only substring-matches `LAL_HOST` to *pick a
  provider name* (`anthropic.com` → `anthropic`, `openai.com` →
  `openai`, and the like) — it then **discards the host string**.
  `resolveModel` resolves that provider through pi-ai's built-in
  registry (`getModel(provider, modelId)`), whose `Model` carries
  pi-ai's own hardcoded endpoint (`https://api.anthropic.com`,
  `https://api.openai.com/v1`); nothing threads the form's host into
  the request. A mock bound to `127.0.0.1:<port>` would not even
  match a registry substring — it would fall through to the `ollama`
  default — so pointing the form's host at the mock either silently
  exercises the Ollama branch (a false pass for the registry cell)
  or, were a match forced, still dispatches to the real public API,
  the opposite of the off-network property this section relies on.
  The seam Tier 1 needs is a harness-level `baseUrl` override
  threaded from the form/test config into `resolveModel` (a
  `LAL_BASE_URL`-style credential the registry branch honors the way
  the Ollama branch honors `OLLAMA_HOST`), **not** `LAL_HOST`
  substring sniffing. Adding that override seam is a Tier-1
  prerequisite for the registry-provider cell and is budgeted in the
  MVR table below (a day of harness work).

The registry/Ollama split also matters for auth, not just the
endpoint: the registry branch carries a real bearer token while the
`ollama/<id>` case uses a distinct auth-token sentinel (the literal
`'ollama'` fallback rather than a user key), and "point it at
Ollama" is one of the three provider shapes G12 names as in scope.
So, with the registry `baseUrl` seam in place, the Tier-1 smoke
parametrizes the mock gateway over **both** shapes: one run drives a
registry-provider model with a bearer token (redirected via the new
`baseUrl` override), and one drives an `ollama/<id>` model
exercising the sentinel-token branch (redirected via `OLLAMA_HOST`).
Covering only the registry path would let a regression in the Ollama
auth-token handling ship uncaught by the gated smoke; conversely,
until the registry `baseUrl` seam lands, the registry-provider cell
cannot run deterministically offline, and Tier 1 gates G16 on the
Ollama shape alone.

### macOS-runner hazards the plan must design around

The macOS runners have documented failure modes that would make a
naive smoke flaky or unusable.

1. **The corepack yarn DNS flake is a hard precondition.**
   The investigation under
   [issue #260](https://github.com/endojs/endo-but-for-bots/issues/260)
   found that the dominant macOS-CI failure is not a test flake
   but `getaddrinfo ENOTFOUND repo.yarnpkg.com` during corepack's
   `yarn@4.13.0` auto-download, in roughly 8% of macOS
   jobs, aborting before any Familiar code runs.
   The smoke is only meaningful once the canonical fix lands:
   vendor `.yarn/releases/yarn-4.13.0.cjs` and set `yarnPath` in
   `.yarnrc.yml` so corepack never fetches.
   This is a blocking dependency of the smoke, optionally with a
   setup-step retry as belt and suspenders.
2. **The embedded-Node arch must match the runner.**
   `macos-14` is arm64 and `macos-13` is x64; the smoke downloads
   and prepares the `darwin-<arch>` Node that matches its runner,
   as the existing `make` matrix already does through
   `TARGET_ARCH`.
3. **Gatekeeper and quarantine.**
   Notarization (G2) is deferred, but the smoke does not need it:
   it launches the locally-built binary inside the `.app`
   directly, not the `.dmg` and not through `open`, so there is
   no `com.apple.quarantine` attribute and no Gatekeeper prompt.
4. **Flake budget.**
   Keep the mock gateway in-process so no external network is in
   the assertion path, wrap the network-touching setup steps in a
   retry, and hold Tier 2 non-blocking until its flake rate is
   measured against the Tier-1 baseline.

### Platform coverage of the runtime tiers

The maintainer asked for the plan "specifically on the macOS
environment," so the tiers above are written against macOS
runners. But Open Question 4's resolution (see Open questions,
below) widened the MVR ship list to three first-class targets:
macOS arm64, macOS x64, and **Linux x64**, and G16 (the
Primer-into-CAS path) is rated **Blocker**. A Blocker whose
runtime verification runs on only one of three shipped platforms
leaves the other two shipping on build-only evidence:
`familiar-release.yml` proves each target *packages*, but nothing
proves the packaged Linux x64 or macOS x64 daemon actually *runs*
the Primer-into-CAS chain. A broken Linux daemon would ship and
surface only in the field.

Tier 1 is the tier that closes that gap, and it has no macOS
dependency: it is a headless daemon-plus-CapTP smoke against an
in-process mock gateway (no display, no live model), so it runs
on `ubuntu-latest` at comparable cost to a macOS cell. The plan
therefore **extends Tier 1 into a matrix across all three MVR
runners** (`macos-14` arm64, `macos-13` x64, `ubuntu-latest`
x64), so the Blocker G16 assertions gate on every platform the MVR
ships. Tier 0 (build smoke) and Tier 2 (GUI launch) keep their
macOS framing, but the two tiers ride different mechanisms and it
is worth being precise about which. The **per-PR** Tier 0 build
smoke runs on `macos-14` alone (each Tier 1 cell builds its own
platform's package, as noted above). The pre-existing
`familiar-release.yml` build *matrix* that fires on dispatch/tag is
the thing that already exercises all three build cells. Tier 2 is
the display-bound tier that stays macOS-only for MVR (headless
Linux would need `xvfb`), carried as followup work rather than an
MVR gate.

Because Tier 2 stays macOS-only, the Linux x64 GUI launch ships
with **no CI launch evidence at all**, and that residual is not
merely a generic display-bound gap. G4 identifies Linux as the
*more* fragile launch path of the three, because the
`chrome-sandbox` setuid workaround (or the userns fallback G4
now flags) is a **known**, previously-identified failure mode, not
a speculative one, and the phased plan only *documents* that setup
step in the README rather than exercising the launched Linux
`.app` under CI. A broken Linux GUI launch would still fail the
Linux MVR exit criterion. MVR therefore knowingly carries this as
an **acknowledged Blocker-adjacent risk on the Linux launch path**,
mitigated only by documentation until a Linux Tier 2 (under
`xvfb`) lands in followups; it is deliberately not downgraded to a
generic display-bound residual, because the failure mode is a
named one.

### Where this lands in the plan

Tier 0 and Tier 1 resolve G16 with a concrete mechanism, so they
join the MVR list; Tier 0 gates per-PR on `macos-14` and Tier 1
gates per-PR across all three MVR runners.
Tier 2 and the broader cross-platform launch matrix ride the
release workflow and a nightly schedule, so they sit in
followups.
The yarn-vendoring precondition (hazard 1) is a blocking
dependency that should land before the smoke is gated, so a flake
in CI infrastructure is not charged to the Familiar smoke.

## Phased plan

### MVR: minimum to ship

The exit criterion is: a user on macOS arm64 (the maintainer's
primary platform) downloads a `.dmg`, double-clicks, drags
Familiar to Applications, launches it, fills in their LLM
provider details, and exchanges messages with `lal`.
No developer tooling is touched on the user's machine, with one
acknowledged, documented exception: the macOS Gatekeeper `xattr`
workaround (G2).
macOS x64 (the third MVR-shipped platform) reaches the same
end state by the same `.dmg` path as arm64, riding the identical
CI and packaging shape; it is not called out separately below only
because every exception it introduces, the arm64 path already
carries.

Because the MVR ship list now includes Linux x64, the exit
criterion has a parallel Linux form: a user on Linux x64 downloads
the `.zip`, unpacks it, and reaches the same converse-with-`lal`
end state. That path carries its **own** acknowledged exception to
the "no developer tooling" premise, and a more invasive one than
the macOS `xattr` case: the `chrome-sandbox` binary must have
`chmod 4755` applied and be chowned to root for Chromium's suid
sandbox (G4), which needs `sudo`/root rather than a single
Finder-adjacent terminal command. Like the macOS exception it is a deliberate,
explicitly-acknowledged deviation the README documents, not an
oversight; it is called out here so the Linux path is not read as
premise-clean when it is in fact the sharper of the two
exceptions.

| Item | Resolves | Effort |
|---|---|---|
| Confirm the existing `familiar-release.yml` workflow emits installable per-platform artifacts end to end (it already builds, packages, and publishes on dispatch/tag) | G1, G15, G4 | day |
| Verify the Primer-into-CAS path in a packaged-build smoke test (Tier 1, gated per-PR across all three MVR runners) | G16 | day |
| Add a harness-level `baseUrl` override seam (a `LAL_BASE_URL`-style credential threaded into `resolveModel`'s registry branch) so the Tier-1 registry-provider cell can redirect its outbound endpoint to the in-process mock gateway, off the public network; a prerequisite for the registry-provider half of the Tier-1 smoke (the Ollama half already redirects via `OLLAMA_HOST`) | G16 | day |
| Aggregate third-party LICENSE notices into the bundle | G14 | day |
| Document Node version pin policy in the package README | G5 | day |
| Advance the bundled Node pin from v20.18.1 to a current LTS (now v22.22.3) | G5 | done (2026-05) |
| Rename the Familiar shell log to `familiar-shell.log`; document log locations and state directory in the package README, including which log (`familiar-shell.log` vs `endo.log`) covers which failure class | G10, G13 | day |
| Document the Linux `chrome-sandbox` suid setup, and surface it at the point of friction (the GitHub release/download page next to the Linux `.zip`), not only the README | G4 | day |
| Manually launch the built Linux `.app` on Ubuntu before each tag (release engineer confirms it reaches the converse-with-`lal` end state), backstopping the Blocker-adjacent Linux launch risk until Linux Tier 2 lands | G4 | per release |
| Document the `127.0.0.1:8920` collision case in the README, and surface a daemon-start-failure dialog naming the cause and log path (the dialog is new UI/IPC, not a doc task) | G9 | day to multi-day |
| Surface the macOS Gatekeeper `xattr` workaround at the point of friction (GitHub release/download page, and ideally the DMG background image), not only the repo README | G2 | day |
| Confirm icon assets resolve on every target platform | G7 | day |

The MVR coverage matrix widened (per Open Question 4's
resolution, in the Open questions section below) from "macOS arm64
alone" to macOS arm64, macOS x64, and Linux x64.
macOS arm64 remains the maintainer's primary platform and the
one that exercises every interesting code path in the build
pipeline; the other two ride the same CI shape.
macOS notarization is deferred (G2); early users on macOS unstick
the Gatekeeper dialog with the documented `xattr` workaround.
Windows is out of scope for MVR (G3).

### Followups (post-MVR, pre-Milestone-1-completion)

| Item | Resolves | Effort |
|---|---|---|
| Flatpak manifest for Linux | G4 | week |
| Icon-projection automation (project the `.icns`/`.ico`/`.png` sets from the source icon; the per-platform confirm itself is the MVR item) | G7 | day |
| First-run "test connection" on the LLM config form | G11 | day |
| Consolidated stop/purge via CapTP from Electron main (reviewable material; consolidation deferred past MVR) | G8 | day |
| OS-assigned gateway port to dodge collisions with developer daemons | G9 | day |
| First-run dialog explaining state-directory location for clean uninstall (or rely on packaging uninstall hook) | G10 | day |
| Universal macOS binary via `@electron/universal` | G15 | multi-day |
| Designer pass to flesh out the opt-in telemetry / crash-reporting shape | G13 | designer dispatch |
| Opt-in crash reporter | G13 | multi-week |
| Gardener-designed Node LTS motion-sensing mechanism that maintains an upgrade PR as the LTS window shifts | G5 | gardener dispatch + multi-day |

### Out of scope for this release

- Any change to the `lal` agent's tool surface, capability set, or
  interaction model is out of scope.
- Any change to the daemon's wire protocol is out of scope.
- Outbound HTTP confinement
  ([`endoclaw-network-fetch`](endoclaw-network-fetch.md)) is
  tracked separately under Milestone 1.
- Self-hosting / Docker
  ([`daemon-docker-selfhost`](daemon-docker-selfhost.md)) is
  Milestone 1.
- The Endo Gateway split
  ([`gateway-package`](gateway-package.md)) is multi-milestone; G9's
  long-term shape aligns with that split.
- Multi-agent provisioning is out of scope: Familiar ships only
  `lal`; Fae, bundled in
  [`familiar-bundled-agents`](familiar-bundled-agents.md), is not
  in MVR scope.
- The Chat UI's pending command, edit-message, and slot-slash
  features are tracked under Milestone 4.
- Auto-update (G6) is deferred entirely per the maintainer's
  resolution of Open Question 6.
- macOS code-signing and notarization (G2) are deferred for MVR
  per the maintainer's 2026-05-19 directive; an issue tracks the
  cert-acquisition admin work.
- Windows code-signing (G3) is out of scope for MVR; an issue
  tracks the EV / OV certificate-acquisition process.

## Open questions

These were the questions the original draft posed before MVR work
began.
The maintainer answered them in the 2026-05-19 review pass; the
answers are recorded inline below.

1. **Distribution channel.**
   *Resolution (2026-05-19):* Post artifacts as GitHub releases on
   `endojs/endo-but-for-bots`.
   This implies two followup processes that are out of scope for
   the release pipeline itself but on the roadmap for the surrounding
   project: a ferrying process to copy the release artifacts to the
   `endojs/endo` repository, and a process for proposing a PR on
   `endojs/endo` that updates a document for deployment on
   `docs.endojs.org`.
   Carry-over to `endojs.org` is out of band.

2. **Signing identity.**
   *Resolution (2026-05-19):* A separate issue records the
   instructions to set up the signing identity (see the Followups
   section below).
   The macOS-side signing flow is itself deferred (see G2); the
   issue stages the certificate-acquisition work for whenever the
   project pursues notarization.

3. **Versioning policy.**
   *Resolution (2026-05-19):* The Familiar package stays
   `"private": true` and is never published to npm.
   It is distributed only as a downloadable artifact (per question
   1).
   Whether the `"version"` field bumps from `0.1.0` to a richer
   identifier on the first downloadable build is a followup
   versioning question for the release engineer to decide; the
   important constraint is that no npm publish step is added.

4. **Operating-system coverage matrix for MVR.**
   *Resolution (2026-05-19):* Build the CI pipeline for producing
   releases for all supported targets: macOS arm64, macOS x64, and
   Linux x64.
   The earlier draft's "arm64 alone" position is widened.

5. **Bundled daemon vs. published `@endo/daemon` package.**
   *Resolution (2026-05-19):* The daemon and the Familiar are
   orthogonal concerns.
   Eventually the project will publish the daemon and the Familiar
   separately, and may also host Chat as a separate interface.
   For MVR the current workspace-bundling shape stays; the
   separation is a roadmap concern, not an MVR one.

6. **Auto-update opt-in posture.**
   *Resolution (2026-05-19):* Defer auto-update entirely.
   G6 is moved to the Out-of-scope section above; the opt-in vs.
   opt-out question is deferred until the project is ready to
   pursue auto-update at all.

## References

- Issue [#229](https://github.com/endojs/endo-but-for-bots/issues/229): source.
- [`familiar-electron-shell`](familiar-electron-shell.md): shell.
- [`familiar-daemon-bundling`](familiar-daemon-bundling.md): esbuild pipeline.
- [`familiar-bundled-agents`](familiar-bundled-agents.md): `lal` and Fae bundling.
- [`familiar-localhttp-protocol`](familiar-localhttp-protocol.md): weblet origins.
- [`familiar-unified-weblet-server`](familiar-unified-weblet-server.md): single-port shape.
- [`familiar-gateway-migration`](familiar-gateway-migration.md): gateway in the daemon.
- [`lal-fae-form-provisioning`](lal-fae-form-provisioning.md): form-based config.
- [`lal-reply-chain-transcripts`](lal-reply-chain-transcripts.md): agent transcripts.
- [`endoclaw-network-fetch`](endoclaw-network-fetch.md): outbound HTTP confinement (followup).
- [`gateway-bearer-token-auth`](gateway-bearer-token-auth.md): bearer-token auth (followup).
- [`gateway-package`](gateway-package.md): host-scoped Gateway (out of scope).
- [`daemon-docker-selfhost`](daemon-docker-selfhost.md): Docker (out of scope).
