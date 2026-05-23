# Familiar Per-Platform Packaging Lanes

| | |
|---|---|
| **Created** | 2026-05-22 |
| **Updated** | 2026-05-23 |
| **Author** | endolinbot (designer dispatch, prompted) |
| **Status** | Proposed |
| **Source** | Extension of [`familiar-release.md`](familiar-release.md) G1, G2, G3, G4, G15 |

## What is the Problem Being Solved?

[`familiar-release.md`](familiar-release.md) enumerates packaging gaps
as a G-item checklist (G2 macOS signing, G3 Windows signing, G4 Linux
distribution shape, G15 macOS arm64 vs x64) but it does not lay out
*how* each platform's packaged artifact is built, signed, and
validated end to end.
The in-flight follow-on PRs cover only fragments:

- PR [#318](https://github.com/endojs/endo-but-for-bots/pull/318)
  (`feat/familiar-ci-build-pipeline`) wires the existing pipeline into
  a CI workflow but emits only the raw `@electron/packager` outputs
  (`.app`, `.exe`, linux-directory) plus the existing `.zip` and
  macOS `.dmg`.
  No `.msi`, no `.deb`, no `.rpm`, no signing, no notarization.
- PR [#322](https://github.com/endojs/endo-but-for-bots/pull/322)
  (`design/familiar-flatpak-pipeline`) covers the Linux Flatpak lane
  on its own.
  See [`familiar-flatpak-pipeline.md`](familiar-flatpak-pipeline.md);
  this design **references but does not duplicate** that work.
- PR [#316](https://github.com/endojs/endo-but-for-bots/pull/316)
  (`chore/familiar-lts-node-pin`) advances the bundled Node binary
  to the supported LTS line per G5; orthogonal to packaging
  *shape*, load-bearing for the bytes inside each artifact.

This design fills the missing rungs: the macOS DMG sign + notarize
chain, the Windows installer choice and signing chain, and the Linux
deb + rpm lanes.
The companion design
[`familiar-pre-release-e2e.md`](familiar-pre-release-e2e.md) covers
end-to-end validation and the dedicated pre-release CI workflow that
gates GitHub Release publication.

## Status quo of the build pipeline

The build is **not** Electron Forge.
`packages/familiar/scripts/build.mjs` orchestrates six hand-rolled
steps:

1. `yarn workspace @endo/chat build` (Vite renderer build).
2. `scripts/bundle.mjs` (esbuild CJS bundles for daemon, CLI, worker,
   lal setup, lal agent, Electron main).
3. `scripts/download-node.mjs` (download per-target Node binary from
   `nodejs.org/dist/`).
4. `scripts/prepare-package.mjs` (copy the right Node binary and
   chat dist into the package).
5. `scripts/package-app.mjs` (calls `@electron/packager` directly;
   no `forge.config.cjs` exists).
6. `scripts/make-distributables.mjs` (DMG on macOS via
   `electron-installer-dmg` + `appdmg`; `.zip` on every platform).

Continuity favours grafting new makers onto this hand-rolled shape
rather than switching to Electron Forge wholesale.
Electron Forge would require rewriting the existing scripts as a
`forge.config.cjs` plus a fleet of `@electron-forge/maker-*` packages;
that switch is its own multi-day refactor and a regression risk.
The picks below name the **package** that produces each platform's
artifact and keep `make-distributables.mjs` as the orchestrator.

## Per-platform packaging lanes

### Lane summary

| Platform | Artifact | Producer | Signing | Distribution |
|---|---|---|---|---|
| macOS arm64 / x64 | `.dmg` (signed, notarized) | `electron-installer-dmg` + `@electron/osx-sign` + `@electron/notarize` | Developer ID Application cert | GitHub Releases |
| Windows x64 | `.exe` (NSIS, EV-signed) | `electron-winstaller` (NSIS variant) | EV or OV code-signing cert | GitHub Releases |
| Linux deb | `.deb` | `@electron-forge/maker-deb` invoked standalone | unsigned for MVR; GPG repo signing on a hosted apt repo deferred | GitHub Releases |
| Linux rpm | `.rpm` | `@electron-forge/maker-rpm` invoked standalone | unsigned for MVR; GPG repo signing on a hosted dnf repo deferred | GitHub Releases |
| Linux flatpak | `.flatpak` single-file bundle | `flatpak-builder` per [`familiar-flatpak-pipeline.md`](familiar-flatpak-pipeline.md) | OpenPGP signing deferred | GitHub Releases |

The Linux `.zip` and the unsigned macOS `.dmg` that the current
pipeline already emits stay in the artifact list as
fallback-for-developers downloads; they are not the primary install
path for a non-developer user.

### macOS DMG (signed and notarized)

**Artifact:** A signed, notarized `.dmg` per architecture
(`Familiar-<version>-darwin-arm64.dmg`,
`Familiar-<version>-darwin-x64.dmg`).
Universal binaries via `@electron/universal` are a **followup**
(per G15); the two-architecture matrix is simpler and matches the
existing CI shape.

**Producer:** The current `make-distributables.mjs` already calls
`electron-installer-dmg` to emit an unsigned `.dmg`.
The signing chain wraps that step:

1. **Sign the `.app` bundle** before DMG creation, with
   `@electron/osx-sign`.
   The sign step takes a Developer ID Application certificate
   (from the maintainer's Apple Developer account) and walks the
   `Familiar.app/Contents/` tree signing each Mach-O binary
   (Electron framework, helpers, bundled `node`, native modules).
   Hardened runtime is enabled (`hardenedRuntime: true`).
   Entitlements: at minimum `com.apple.security.cs.allow-jit`
   (for V8) and `com.apple.security.cs.allow-unsigned-executable-memory`
   (for SES lockdown, which mutates code generators).
   The full entitlements list is captured in
   `packages/familiar/build/entitlements.plist` as a checked-in
   file.
2. **Build the DMG** from the signed `.app` (existing call).
3. **Sign the DMG** itself with the same Developer ID certificate
   (a separate `codesign` invocation on the `.dmg` so the volume
   carries a signature, not just the contained `.app`).
4. **Notarize the DMG** with `@electron/notarize`, which submits
   to Apple's notary service via `xcrun notarytool` and polls for
   acceptance.
   The notarize step takes an App Store Connect API key
   (`API_KEY`, `API_KEY_ID`, `API_KEY_ISSUER`).
   `altool` is decommissioned; only `notarytool` is supported.
5. **Staple the ticket** with `xcrun stapler staple Familiar.dmg`
   so the DMG carries the notarization ticket offline and
   Gatekeeper accepts it without a network round-trip on first
   open.

**Signing identity:** Developer ID Application certificate.
The cert and the App Store Connect API key live as **GitHub Actions
encrypted secrets** (`APPLE_CERT_P12`, `APPLE_CERT_PASSWORD`,
`APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_KEY_ISSUER`).
The runner imports the `.p12` into a temporary keychain at job
start and drops the keychain at job end.
Apple's Notary service rate-limits and (as of 2026-05) occasionally
delays submissions; the workflow's notarize step has a 30-minute
timeout and retries once before failing the job.

**Auto-update:** Out of scope for MVR per
[`familiar-release.md`](familiar-release.md) G6.
When revisited, `electron-updater` against a GitHub Releases manifest
(or `Sparkle` framework via `@vercel/sparkle`) signs against the
same Developer ID; the `.dmg` is the install medium, not the
update medium.

**Alternatives considered:**

- *PKG installer.* macOS `.pkg` (Apple's flat-package format)
  supports unattended install via `installer` CLI and lands the
  app in a chosen path.
  Rejected: the Familiar is a self-contained `.app`; drag-to-
  `/Applications/` from a `.dmg` is the idiomatic macOS install
  surface and the user already understands it.
- *Mac App Store submission.* Out of scope: MAS imposes
  sandbox restrictions (no spawning external Node binaries) that
  conflict with the daemon-bundling architecture
  ([`familiar-daemon-bundling.md`](familiar-daemon-bundling.md)).

### Windows installer (NSIS via `electron-winstaller`)

**Artifact:** A signed `.exe` installer per architecture
(`Familiar-<version>-win32-x64.exe`).
Windows arm64 (Surface Pro X, Snapdragon laptops) is a followup;
x64 is the MVR coverage.

**Producer pick: NSIS via `electron-winstaller`** (the NSIS-based
"Setup.exe" the Electron community calls "Squirrel.Windows" but
which `electron-builder` documents as the NSIS variant).
Justified below against the alternatives.

**Rationale:**

- *Squirrel.Windows-style auto-update* (differential patches, no
  UAC on update) is the Electron-native update story; Electron's
  `autoUpdater` module on Windows expects either NSIS+Squirrel or
  MSIX, and `.msi` is "long missing" (was added recently to
  `electron-wix-msi` via a special Squirrel integration but the
  story is bumpier).
- *SmartScreen reputation* accrues against the **signing
  certificate**, not the installer format.
  An EV cert grants immediate SmartScreen pass-through; an OV
  cert (cheaper, no hardware token) accumulates reputation over
  download volume.
  The choice of NSIS vs MSI does not change this calculation.
- *Smaller and faster.* NSIS installers are typically 60% the
  size of equivalent MSIs and install in half the time on a cold
  system.
- *Electron-side support is first-class.* `electron-winstaller`
  is maintained by the Electron team and is what
  `@electron-forge/maker-squirrel` wraps.

**Alternatives considered:**

- *WiX MSI* via `electron-wix-msi` or
  `@electron-forge/maker-wix-msi`.
  Rejected as primary because: (a) requires WiX Toolset v3
  installed on the build host (a Windows-only build dependency
  the runner has to install per job), (b) auto-update via
  Squirrel-in-MSI is a recent and bumpy integration, (c) bigger
  artifacts.
  **Reconsider** if the maintainer wants group-policy deployment
  (Active Directory `.msi` push) for enterprise install; revisit
  as a secondary lane alongside NSIS if that need arises.
- *MSIX* via `@electron-forge/maker-msix`.
  Rejected as primary because: (a) MSIX requires sideload-enabled
  Windows or Microsoft Store distribution (the Microsoft Store
  submission is a separate followup, see G2/G3 analog), (b) MSIX
  apps run inside the modern packaged-app sandbox which is
  incompatible with spawning the bundled `node` binary as a
  detached daemon (the Familiar's core architecture per
  [`familiar-electron-shell.md`](familiar-electron-shell.md)).
  **Reconsider** when the Familiar's daemon-spawning shape is
  reworked to fit MSIX's runtime model, which is its own design
  question.
- *Portable `.zip`.*  Already produced today; not an installer.
  Stays in the artifact list for power users.

**Signing identity:** EV code-signing certificate from a CA that
issues to organizations (DigiCert, Sectigo, Certum).
EV certs ship on a FIPS-140-2 hardware token (USB or HSM), which
**cannot live on a GitHub-hosted runner**.
Two routes for keeping the signing key off the runner:

1. **Cloud HSM** (AWS KMS, Azure Key Vault, Google Cloud KMS):
   the EV cert is provisioned into the HSM; the runner authenticates
   with a workload identity, hands the binary to the HSM, the HSM
   returns the signature.
   `signtool /dg` (DGST mode) supports detached signing for this
   shape.
2. **Self-hosted Windows runner** that has the hardware token
   plugged in.
   The maintainer's workstation or a dedicated build VM hosts the
   runner.
   Lower setup cost, higher ongoing cost (the runner must be
   reachable when CI fires).

**Recommendation:** Cloud HSM (Azure Key Vault is the path most
documented for `signtool`).
Surface signing-identity custody as an open question; the choice
between EV (faster reputation, harder ops) and OV (cheaper, slower
reputation) is the maintainer's call.

**Auto-update:** Out of scope for MVR per G6.
When revisited, NSIS+Squirrel updates via `electron-updater`
against a GitHub Releases manifest is the canonical path.

### Linux deb

**Artifact:** A `.deb` per architecture
(`familiar_<version>_amd64.deb`, `familiar_<version>_arm64.deb` as
followup).

**Producer:** `@electron-forge/maker-deb` invoked **as a library**,
not through the full Electron Forge pipeline.
`make-distributables.mjs` adds a Linux branch that:

1. Takes the existing `out/Familiar-linux-<arch>/` packaged-app
   directory.
2. Calls `MakerDeb.prototype.make({ dir, makeDir, targetArch,
   appName, packageJSON })`.
3. Emits `out/make/familiar_<version>_amd64.deb`.

`@electron-forge/maker-deb` wraps `electron-installer-debian` under
the hood; the latter can also be invoked directly if Electron Forge
internals shift.

The `.deb` package declares dependencies on the libraries Chromium
needs that the system provides (`libgtk-3-0`, `libnotify4`,
`libnss3`, `libxss1`, `libxtst6`, `xdg-utils`, `libatspi2.0-0`,
`libdrm2`, `libgbm1`, `libxcb-dri3-0`).
The full dependency list is generated by Electron's `linux-deps`
recipe and pinned in the maker config.

The package installs:

- The Familiar Electron app under `/opt/Familiar/`.
- A `/usr/bin/familiar` symlink to the Electron entry.
- A `/usr/share/applications/familiar.desktop` XDG desktop entry
  for application-menu integration.
- Icons under `/usr/share/icons/hicolor/<size>/apps/familiar.png`.
- `chrome-sandbox` with `setuid` bit preserved
  (the `.deb` postinst runs `chown root:root && chmod 4755` on
  `/opt/Familiar/chrome-sandbox` as the install's only privileged
  step).

**Distribution:** For MVR, the `.deb` attaches to the GitHub Release.
The user downloads and installs with
`sudo apt install ./familiar_<version>_amd64.deb` (apt resolves
declared dependencies from the user's distro repos automatically).

**Hosted apt repo:** Deferred.
Hosting an apt repo requires GPG-signing the repo metadata (the
`Release` file) with a key that is published on
`apt-key add` / `gpg --recv-key`.
The repo would live at `https://endojs.org/apt/` (or a CloudFront-
fronted S3 bucket) with a `dists/stable/main/binary-amd64/` tree.
The followup tracking issue records the cert-acquisition and
repo-bootstrap work; for MVR the GitHub Release is the channel.

**Signing:** Unsigned for MVR.
A signed `.deb` (via `dpkg-sig`) is a follow-on once the GPG-signing
key for the apt repo exists; the same key signs both.

### Linux rpm

**Artifact:** An `.rpm` per architecture
(`familiar-<version>-1.x86_64.rpm`,
`familiar-<version>-1.aarch64.rpm` as followup).

**Producer:** `@electron-forge/maker-rpm` invoked as a library,
mirror of the deb lane.
Wraps `electron-installer-redhat` under the hood.

The `.rpm` declares dependencies on the Fedora/RHEL/Rocky-equivalent
libraries (`gtk3`, `libnotify`, `nss`, `libXScrnSaver`, `libXtst`,
`xdg-utils`, `at-spi2-core`, `libdrm`, `mesa-libgbm`).
The post-install scriptlet runs the same `chown root:root && chmod
4755` on `chrome-sandbox`.

**Distribution:** GitHub Releases for MVR.
The user installs with
`sudo dnf install ./familiar-<version>-1.x86_64.rpm` (dnf resolves
declared dependencies from the user's distro repos automatically).

**Hosted dnf repo:** Deferred, same shape as the apt repo above.
Would live at `https://endojs.org/dnf/` with a `repodata/` tree
signed with the same GPG key.

**Signing:** Unsigned for MVR.
A signed `.rpm` (via `rpm --addsign`) is a follow-on alongside the
hosted dnf repo.

### Linux flatpak (cross-link to PR [#322](https://github.com/endojs/endo-but-for-bots/pull/322))

The Flatpak lane is described in detail in
[`familiar-flatpak-pipeline.md`](familiar-flatpak-pipeline.md)
(PR [#322](https://github.com/endojs/endo-but-for-bots/pull/322), Proposed).
That design names the manifest shape, the
`org.electronjs.Electron2.BaseApp` base, the `finish-args`
capability surface, `zypak-wrapper` for Chromium sandboxing, and
the OpenPGP signing posture (deferred for MVR, single-file `.flatpak`
bundle is the artifact).
This design does not duplicate that material.
The pre-release CI workflow in
[`familiar-pre-release-e2e.md`](familiar-pre-release-e2e.md)
incorporates the Flatpak job alongside deb / rpm so all Linux lanes
share one runner image where possible.

## Cross-cutting concerns

### Reproducibility

The aspiration is a per-tag reproducible build: a given `familiar-v*`
tag rebuilt from the same git ref produces the same bytes.
The current pipeline does not meet this bar because:

- The signing timestamp embeds the signing wall-clock time
  (`SOURCE_DATE_EPOCH` and `--timestamp` flags can mitigate but
  not eliminate this for Authenticode).
- The downloaded Node binary's `mtime` differs per CI run.
- The Vite bundle includes a content hash that depends on
  module-resolution ordering, which is deterministic but the
  inputs (the dependency tree) shift as transitive deps
  upgrade.

The MVR posture: best-effort determinism (`yarn install --immutable`,
pinned Node download, pinned Electron version, deterministic
esbuild output) plus published SHA-256 checksums for each artifact
attached to the GitHub Release.
A future reproducibility audit is a separate designer pass; the
checksums plus the public CI run logs are the verifier for the
MVR phase.

### Version stamping

The artifact filename embeds `pkg.version` from
`packages/familiar/package.json`.
The CI pre-release workflow refuses to publish a release if the
git tag (`familiar-v<version>`) does not match `pkg.version`;
this is a pre-flight gate in
[`familiar-pre-release-e2e.md`](familiar-pre-release-e2e.md).

The version field in `Info.plist` (macOS), `VERSIONINFO` resource
(Windows), and the deb/rpm metadata is set by the respective
maker from the same `pkg.version`; no drift across artifact
embeddings.

### Bundled Node version coordination

The Node binary embedded in each artifact comes from
`scripts/download-node.mjs`.
The currently-pinned LTS version
(post-PR [#316](https://github.com/endojs/endo-but-for-bots/pull/316),
Node 22.x) flows into every lane uniformly.
The pre-release workflow's pre-flight step asserts that
`download-node.mjs`'s pinned version matches what the CI's
`actions/setup-node` step uses; mismatches fail the workflow before
any artifact is built.

### Bundled-Primer / agent-bundle freshness

The `lal` Primer ships inside the artifact via
`scripts/bundle.mjs`'s copy of `packages/lal/primer/` into
`packages/familiar/bundles/primer/`.
The pre-release workflow asserts that the Primer's git tree hash
matches the agent bundle's expected version (a single SHA recorded
in `packages/familiar/bundles/primer.sha`); a Primer that drifts
from the agent's `import.meta.url` expectations fails the workflow
at the verification step before any artifact is built.

## Phased implementation

| Phase | Deliverable | Effort |
|---|---|---|
| 1 | macOS DMG sign + notarize chain (existing DMG step extended with `@electron/osx-sign` + `@electron/notarize`). | Day (builder) + administrative cost of acquiring Developer ID Application cert. |
| 2 | Linux deb lane (`@electron-forge/maker-deb` invoked from `make-distributables.mjs`). | Day (builder). |
| 3 | Linux rpm lane (`@electron-forge/maker-rpm` invoked from `make-distributables.mjs`). | Day (builder). |
| 4 | Windows NSIS lane (`electron-winstaller`); signing chain deferred to phase 4b. | Multi-day (builder). |
| 4b | Windows signing chain (Cloud HSM or self-hosted runner with EV token). Unblocks [`familiar-pre-release-e2e.md`](familiar-pre-release-e2e.md) Phase 3b (flipping the pre-release workflow's Windows `make-nsis` + `e2e-windows` lanes from continue-on-error to blocking). | Multi-week, dominated by cert-acquisition admin and HSM provisioning. |
| 5 | Flatpak lane (carried by PR [#322](https://github.com/endojs/endo-but-for-bots/pull/322); designer references). | Per PR #322. |
| 6 | Pre-release CI workflow with E2E across all lanes (companion design). | Per [`familiar-pre-release-e2e.md`](familiar-pre-release-e2e.md). |
| 7 | Hosted apt + dnf repos with GPG-signed repo metadata; auto-update channels. | Multi-week each, post-MVR. |
| 8 | Universal macOS binary via `@electron/universal`; Windows arm64; Linux arm64. | Multi-day per architecture, post-MVR. |

Phases 1 to 4 are MVR-completion work that closes the G2/G3/G4
gaps from [`familiar-release.md`](familiar-release.md).
Phase 6 is the gate that turns "we have artifacts" into "we
publish a Release"; without it the per-PR build pipeline (PR #318)
emits artifacts but nothing gates the GitHub Release publication.

## Dependencies

| Design | Relationship |
|---|---|
| [`familiar-release.md`](familiar-release.md) | Source; this design extends G2/G3/G4/G15. |
| [`familiar-pre-release-e2e.md`](familiar-pre-release-e2e.md) | Companion design; covers E2E and the pre-release CI workflow that gates publication. |
| [`familiar-electron-shell.md`](familiar-electron-shell.md) | Defines the Electron-main process this design packages. |
| [`familiar-daemon-bundling.md`](familiar-daemon-bundling.md) | The bundled daemon + Node binary each lane ships. |
| [`familiar-bundled-agents.md`](familiar-bundled-agents.md) | The `lal` setup and agent bundles each lane ships. |
| [`familiar-flatpak-pipeline.md`](familiar-flatpak-pipeline.md) | Cross-link to PR [#322](https://github.com/endojs/endo-but-for-bots/pull/322); the Flatpak lane lives there. |
| [`chat-playwright-smoke.md`](chat-playwright-smoke.md) | E2E precedent the companion design extends. |

## Design Decisions

- **Stay with `@electron/packager` plus hand-rolled scripts, not
  Electron Forge.**
  The existing pipeline is hand-rolled.
  Switching to Forge wholesale is a separate refactor with no
  packaging-correctness payoff; the Forge makers can be invoked
  as libraries from `make-distributables.mjs` without adopting the
  surrounding Forge pipeline.
- **NSIS via `electron-winstaller`, not WiX MSI, as the primary
  Windows installer.**
  Smaller artifact, faster install, mainstream auto-update
  integration (Squirrel.Windows is the Electron-native path).
  WiX MSI stays available as a secondary lane if group-policy
  enterprise deployment becomes a requirement.
- **Defer MSIX entirely** for MVR; revisit when the daemon-spawning
  shape is reworked to fit MSIX's runtime model.
- **EV cert via Cloud HSM** is the recommended Windows signing
  shape; OV via local hardware token is the cheaper alternative.
  Surface the custody question as open.
- **Apple `notarytool` is mandatory.**
  `altool` is decommissioned; the workflow uses `@electron/notarize`
  which already routes through `notarytool`.
- **Unsigned `.deb` / `.rpm` and unsigned Flatpak bundle for MVR.**
  Signing requires a GPG key and a hosted repo; the hosted-repo
  followup carries both.
  The GitHub Release attachment route does not require signed
  packages; the user's `apt install ./file.deb` accepts the
  unsigned package with a prompt.
- **Architecture matrix: macOS arm64, macOS x64, Linux x64, Windows
  x64 for MVR.**
  arm64 on Linux and Windows, plus universal macOS, are followups.
- **Hosted apt / dnf repos and the EV / Developer ID cert
  acquisition are tracked under separate issues** rather than
  inlined into the design.
  The cert-acquisition admin work blocks the signing chain but is
  parallel to the build-script work; surface it explicitly so the
  maintainer can pursue them in parallel.

## Open Questions

1. **Windows code-signing custody.**
   Cloud HSM (Azure Key Vault recommended) or self-hosted Windows
   runner with EV USB token?
   The HSM route shifts the credential surface from the
   maintainer's workstation to a cloud account; the runner route
   keeps the credential local but adds maintenance burden.
   The maintainer's call; the choice does not block the lane
   itself, only the signing step.
2. **EV vs OV certificate** for Windows.
   EV grants immediate SmartScreen reputation; OV is cheaper and
   accumulates reputation through download volume.
   Maintainer's cost/benefit call.
3. **Universal macOS binary timing.**
   `@electron/universal` glues a per-arch build pair into one
   `.app` that runs on either architecture.
   Defer to followups, or land alongside the signing chain in
   phase 1?
4. **Hosted apt / dnf repo URL and key custody.**
   `https://endojs.org/apt/` and `https://endojs.org/dnf/` are the
   natural URLs; the GPG signing key for repo metadata lives where
   (1Password vault, AWS KMS, the maintainer's offline backup)?
   Same key for both, or separate keys per ecosystem?
5. **deb / rpm dependency declarations.**
   The exact dependency list per-distro is best maintained against
   a known-good Ubuntu LTS and Fedora release.
   Which versions does MVR target?
   Ubuntu 24.04 LTS and Fedora 40 are the obvious picks (current
   stable releases of each); confirm.
6. **macOS notarization API key custody.**
   The App Store Connect API key is per-Apple-Developer-account.
   Same Apple Developer account as G2's Developer ID, or a
   service-account split?
7. **Maintenance window for cert renewals.**
   Developer ID Application certs expire after 5 years; EV/OV
   Windows certs after 1 to 3 years.
   The followup tracking issue records the renewal calendar.

## Prompt

Per the liaison's 2026-05-22 dispatch (
`journal/entries/2026/05/22/203143Z-dispatch-liaison-60e957.md`),
relaying the maintainer's directive:

> Please dispatch a designer to extend our existing narrative on
> shipping packaged releases of the Familiar application, with
> separate lanes for MacOS (dmg), Windows (msi, presumably, but
> you might know or find better information), Linux (deb, rpm,
> and flatpack) with particular attention to end-to-end testing
> in the validation feedback loop for all of these variations,
> in dedicated CI pre-release workflows.

The Windows-installer question ("msi, presumably, but you might
know or find better information") resolves to **NSIS via
`electron-winstaller`** with EV signing via Cloud HSM as the
recommended shape; the rationale and the alternatives are
captured under *Windows installer* above.
The companion design
[`familiar-pre-release-e2e.md`](familiar-pre-release-e2e.md)
covers the end-to-end testing and the dedicated pre-release CI
workflow.
