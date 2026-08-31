# Familiar Flatpak Packaging Pipeline

| | |
|---|---|
| **Created** | 2026-05-19 |
| **Updated** | 2026-05-22 |
| **Author** | endolinbot (builder dispatch) |
| **Status** | Proposed |
| **Source** | `familiar-release.md` (PR [#231](https://github.com/endojs/endo-but-for-bots/pull/231)) G4 (line 205): "Please dispatch a builder to propose a pipeline for Flatpack. We can defer the other packaging systems." |

## What is the Problem Being Solved?

The Familiar's `make-distributables.mjs` produces a `.zip` on Linux.
A user who unzips it gets a directory tree that includes an Electron
binary, a Chromium runtime, and `chrome-sandbox`, the latter of which
must be `chmod 4755` and chowned to root for Chromium's setuid sandbox
to engage.
A non-developer will not perform that chmod and chown; without it
Electron either refuses to launch or falls back to `--no-sandbox`,
which silently strips a meaningful layer of process isolation from
the daemon's worker tree.

The maintainer's resolution of `familiar-release.md` (PR
[#231](https://github.com/endojs/endo-but-for-bots/pull/231)) G4
(2026-05-19) chose Flatpak as the single Linux packaging format
for MVR (Minimum Viable Release) followups; AppImage, `.deb`,
`.rpm`, and `.tar.gz` are deferred.
The `G<N>` codes used throughout this document (G4, G5, G6, G11,
G12, G16) reference the correspondingly-numbered decision items in
`familiar-release.md`; each is a maintainer resolution the design
carries a dependency on.
Flatpak is the right pick because it ships its own setuid-capable
sandbox (`bwrap`, configured by the runtime).
The `chrome-sandbox` chmod story collapses into the runtime's existing
sandbox setup.

This document proposes the pipeline that turns the Familiar's
existing `out/Familiar-linux-x64/` packaged-app directory into an
unsigned, integrity-checkable `.flatpak` single-file bundle
suitable for posting to the project's GitHub Releases page (per
`familiar-release.md` (PR
[#231](https://github.com/endojs/endo-but-for-bots/pull/231)) Open
Question 1's resolution).
Signing is deferred out of the MVR-followups phase; see § Signing
Posture (Deferred) for the deferral rationale and the interim
unsigned-install story.

The replacement is materially easier for the same non-developer than
the chmod/chown it removes. The chmod/chown is a per-file, must-be-root
step with no discoverable prompt and a silent-degradation failure mode
(Chromium quietly runs unsandboxed); the Flatpak path is the platform's
standard install gesture — on a desktop with GNOME Software / KDE
Discover the `.flatpak` double-click installs through the GUI with no
terminal at all, and even the terminal form is a single
`flatpak install --bundle <file>`. Flatpak is preinstalled on Fedora
and popular immutable distros and is a one-time `apt install flatpak`
elsewhere; that prerequisite (and its absence as a failure mode) is
named explicitly in the end-user install snippet under § Signing
Posture. `flatpak-builder` is a *build-host* tool, not an end-user
requirement — the end user installs a prebuilt bundle and never runs
the builder.

## Status Quo

The Familiar's existing Linux output path is:

- `node scripts/build.mjs` runs the six pipeline steps documented
  in `familiar-release.md` (PR
  [#231](https://github.com/endojs/endo-but-for-bots/pull/231))
  Status Quo.
- The fifth step (`@electron/packager`) produces
  `packages/familiar/out/Familiar-linux-x64/` containing the
  Electron-app directory tree.
- The sixth step (`make-distributables.mjs`) currently emits
  `out/make/Familiar-<version>-linux-x64.zip` via the system `zip`.
- The CI surface
  ([`.github/workflows/familiar-release.yml`](../.github/workflows/familiar-release.yml))
  uploads the zip as a workflow artifact and attaches it to a
  draft GitHub Release.

The Flatpak pipeline grafts onto this shape between steps 5 and the
GitHub-Release upload.

## Design

### Pipeline Shape

```mermaid
flowchart TD
  P[step 5: package-app.mjs<br/>out/Familiar-linux-x64/] --> A
  A[step 6a: stage Flatpak inputs<br/>scripts/build-flatpak.mjs] --> B
  B[step 6b: flatpak-builder<br/>--repo=repo build org.endojs.Familiar.json] --> C
  C[step 6c: flatpak build-bundle<br/>repo -> .flatpak single file] --> D
  D[out/make/Familiar-&lt;version&gt;-linux-x64.flatpak]
  P --> Z[step 6: existing zip<br/>retained for unsigned download]
```

Step 5 (`package-app.mjs`) is the `@electron/packager` step
documented in `familiar-release.md` (PR
[#231](https://github.com/endojs/endo-but-for-bots/pull/231))
Status Quo; it produces the packaged-app directory tree under
`out/Familiar-linux-x64/`.
Steps 6a, 6b, and 6c are all driven by a single script
(`scripts/build-flatpak.mjs`) that stages inputs, invokes the
builder, and emits the bundle; the diagram names the conceptual
phases for readability.

The existing `.zip` output stays for the plain-download case; the
Flatpak adds a sandboxed, integrity-checkable alternative (unsigned
in the MVR-followups phase; see § Signing Posture (Deferred)).
Both ride the same CI artifact list.

### Manifest Shape

The canonical Flatpak manifest is a single JSON file at
`packages/familiar/flatpak/org.endojs.Familiar.json`.
The file is checked in; the build is reproducible from a checkout.

```json
{
  "app-id": "org.endojs.Familiar",
  "runtime": "org.freedesktop.Platform",
  "runtime-version": "24.08",
  "sdk": "org.freedesktop.Sdk",
  "base": "org.electronjs.Electron2.BaseApp",
  "base-version": "24.08",
  "command": "familiar",
  "separate-locales": false,
  "finish-args": [
    "--share=ipc",
    "--share=network",
    "--socket=fallback-x11",
    "--socket=wayland",
    "--device=dri",
    "--filesystem=xdg-run/endo:create",
    "--filesystem=xdg-state/endo:create",
    "--filesystem=xdg-cache/endo:create"
  ],
  "modules": [
    {
      "name": "familiar",
      "buildsystem": "simple",
      "build-commands": [
        "install -d /app/familiar",
        "cp -a Familiar-linux-x64/. /app/familiar/",
        "install -Dm755 launcher.sh /app/bin/familiar",
        "install -Dm644 org.endojs.Familiar.desktop /app/share/applications/org.endojs.Familiar.desktop",
        "install -Dm644 org.endojs.Familiar.metainfo.xml /app/share/metainfo/org.endojs.Familiar.metainfo.xml",
        "for size in 16 32 64 128 256 512 1024; do install -Dm644 icons/icon-${size}.png /app/share/icons/hicolor/${size}x${size}/apps/org.endojs.Familiar.png; done"
      ],
      "sources": [
        { "type": "dir", "path": "build" }
      ]
    }
  ]
}
```

#### Runtime Choice: `org.freedesktop.Platform//24.08`

The freedesktop runtime is the lowest-common-denominator runtime that
ships glibc, GTK pieces Electron expects, and the audio / video
libraries Chromium needs.
The 24.08 series is the current stable runtime
([Flathub runtimes page](https://docs.flatpak.org/en/latest/available-runtimes.html));
the runtime-version is pinned per Endo's external-pin discipline
(`familiar-release.md` (PR
[#231](https://github.com/endojs/endo-but-for-bots/pull/231)) G5;
Endo pins external runtime versions in checked-in manifests so
the build is reproducible from a checkout) and bumped in
lockstep with the bundled Node LTS bump.
A future runtime move (24.08 -> 25.x) is a builder pass that
revisits both the Node pin (G5) and this manifest.

#### Base: `org.electronjs.Electron2.BaseApp//24.08`

The Electron base app is published on Flathub at
`org.electronjs.Electron2.BaseApp` and pre-installs the Chromium-side
shared libraries (NSS, libdrm, libnotify, libsecret) that Electron
links against and the freedesktop runtime does not already carry.
Using the base shrinks the manifest from ~30 module entries
(each library built from source) to one `base` line.
The Electron base app's setup also takes care of the
`chrome-sandbox` setuid concern by mapping in `bwrap` from the
runtime, so the README's
`chmod 4755 chrome-sandbox` instruction becomes moot inside the
Flatpak.

#### Finish-Args: Capability Surface Justification

The `finish-args` block is the Flatpak sandbox's hole-poking list.
Each line below is justified against a specific runtime requirement
that the Familiar's existing implementation already exercises:

| Permission | Rationale |
|---|---|
| `--share=ipc` | Electron's renderer / utility processes use SysV IPC for shared-memory transport with the GPU process. |
| `--share=network` | The bundled `lal` agent issues outbound `fetch` requests against `https://api.anthropic.com/`, `https://api.openai.com/`, and a user-configured LLM endpoint (`familiar-release.md` (PR [#231](https://github.com/endojs/endo-but-for-bots/pull/231)) G12). The gateway's localhost-socket bind does not depend on this permission (loopback is local); only the outbound LLM fetch does. |
| `--socket=fallback-x11` | X11 fallback when the host is on Xorg (older distros, NVIDIA-on-Wayland workarounds). |
| `--socket=wayland` | Wayland is the default on modern distros (Fedora, recent Ubuntu, Pop!_OS). |
| `--device=dri` | GPU acceleration for the Chromium renderer; without it Electron falls back to swrast and the chat UI's text rendering becomes janky. |
| `--filesystem=xdg-run/endo:create` | `@endo/where`'s `whereEndoSock` resolves the daemon's captp socket under `$XDG_RUNTIME_DIR/endo/` on Linux (grouped with `whereEndoEphemeralState`, distinct from `whereEndoState`), and `daemon-manager.js` binds that socket in-process inside the sandbox. Flatpak auto-binds only `xdg-run/app/<app-id>`, not arbitrary `$XDG_RUNTIME_DIR` subpaths, so this grant is required or the bundled daemon cannot bind its socket at launch. This is the load-bearing line for daemon launch. |
| `--filesystem=xdg-state/endo:create` | `@endo/where`'s `whereEndoState` resolves under `$XDG_STATE_HOME/endo/` on Linux, and the daemon's state directory (the CAS, the `gateway` file) lives there. |
| `--filesystem=xdg-cache/endo:create` | `@endo/where`'s `whereEndoCache` resolves under `$XDG_CACHE_HOME/endo/` on Linux; the daemon writes cache entries there. |

Each entry above corresponds to a runtime requirement the Familiar's
existing implementation exercises today.
Speculative, not-yet-wired surfaces are deliberately excluded from
this manifest and are granted in the followup PR that wires the
feature they support, when the real requirement is known: notification
sound (`--socket=pulseaudio`), toast notifications
(`--talk-name=org.freedesktop.Notifications`), and the deferred
migration of the LLM auth token to the host's libsecret
(`--talk-name=org.freedesktop.secrets`, a followup to
`familiar-release.md` (PR
[#231](https://github.com/endojs/endo-but-for-bots/pull/231)) G11).
Adding them here would put entries the Flathub review-gate argument
(below) calls unjustified into a table that claims to hold only
currently-exercised grants.

Each `--filesystem=` line uses `:create` so the directory is brought
into existence inside the sandboxed view on first launch.
The `/endo` suffix scopes the permission to the project's own directory
inside each XDG root rather than handing the whole XDG root to the
sandbox.

#### What the Manifest Excludes

A Flatpak with `--filesystem=host` or `--filesystem=home` is
**explicitly not** what we ship.
The narrower set above is the review-gate Flathub uses; submitting
against the broader set would delay listing and weaken the security
story.
The specific exclusions:

- No `--talk-name=org.freedesktop.Flatpak` (no auto-update from
  inside the sandbox).
- No `--filesystem=home` (the daemon never reads user files outside
  `$XDG_*_HOME/endo/`).
- No `--device=all` (only DRI for GPU).
- No `--persist=.` (state lives in the XDG directories, not in
  `~/.var/app/`).

### Launcher and Metadata Files

`packages/familiar/flatpak/` holds the small companion files referenced
by the manifest:

```
packages/familiar/flatpak/
  org.endojs.Familiar.json         # the manifest above
  launcher.sh                      # /app/bin/familiar wrapper
  org.endojs.Familiar.desktop      # XDG desktop entry
  org.endojs.Familiar.metainfo.xml # AppStream metadata for Flathub
```

`launcher.sh` (executable, installed to `/app/bin/familiar`):

```sh
#!/bin/sh
# Wrapper for the Familiar Electron app under Flatpak.
# zypak intercepts Chromium's namespace-sandbox calls and routes them
# through Flatpak's bwrap, which is the host's setuid binary.
exec zypak-wrapper /app/familiar/Familiar "$@"
```

The launcher's `/app/familiar/Familiar` path depends on the
`@electron/packager` convention of naming the produced binary after
the package's `productName` (capital F, matching `Familiar`).
A future packager bump or rename of the `productName` field requires
a parallel update to this launcher; the manifest's
`Familiar-${target}` source directory and this launcher path share
the same upstream dependency.

`zypak-wrapper` ships with the `org.electronjs.Electron2.BaseApp`
base; the wrapper is the standard Flathub idiom for Electron apps.
The wrapper replaces the `chrome-sandbox` chmod story entirely.

`org.endojs.Familiar.desktop`:

```ini
[Desktop Entry]
Name=Familiar
GenericName=Endo Familiar
Comment=Local-first chat with the lal agent
Exec=familiar %U
Icon=org.endojs.Familiar
Type=Application
StartupNotify=true
StartupWMClass=Familiar
Categories=Network;Chat;Development;
Keywords=endo;lal;llm;chat;agent;
```

`org.endojs.Familiar.metainfo.xml` (AppStream metadata, required by
Flathub for listing; the schema is documented at
[appstream.org](https://www.freedesktop.org/software/appstream/docs/)):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<component type="desktop-application">
  <id>org.endojs.Familiar</id>
  <name>Familiar</name>
  <summary>Local-first chat with the lal agent</summary>
  <metadata_license>CC0-1.0</metadata_license>
  <project_license>Apache-2.0</project_license>
  <developer id="org.endojs">
    <name>Endo contributors</name>
  </developer>
  <description>
    <p>
      The Familiar is a desktop Electron shell for Endo Chat. It bundles
      the lal agent and a self-contained Endo daemon so a user can hold
      a persistent conversation with their own LLM provider without
      installing any developer tooling.
    </p>
  </description>
  <launchable type="desktop-id">org.endojs.Familiar.desktop</launchable>
  <url type="homepage">https://github.com/endojs/endo-but-for-bots</url>
  <url type="bugtracker">https://github.com/endojs/endo-but-for-bots/issues</url>
  <content_rating type="oars-1.1" />
  <releases>
    <release version="0.1.0" date="2026-05-19" />
  </releases>
</component>
```

### Build Script: `scripts/build-flatpak.mjs`

A new script under `packages/familiar/scripts/` orchestrates the
Flatpak build.
It is invoked after `package-app.mjs` (step 5) on Linux and produces
a single `.flatpak` file under `out/make/`.

```js
// scripts/build-flatpak.mjs
/* global process */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const familiarDir = path.resolve(dirname, '..');

if (process.platform !== 'linux') {
  console.log('Flatpak build only runs on Linux; skipping.');
  process.exit(0);
}

const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
const target = process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64';

const appDir = path.join(familiarDir, `out/Familiar-${target}`);
if (!fs.existsSync(appDir)) {
  console.error(`Packaged app not found at ${appDir}.`);
  console.error('Run the package step first.');
  process.exit(1);
}

const flatpakDir = path.join(familiarDir, 'flatpak');
const stageDir = path.join(familiarDir, 'out/flatpak-stage');
const buildDir = path.join(familiarDir, 'out/flatpak-build');
const repoDir = path.join(familiarDir, 'out/flatpak-repo');
const makeDir = path.join(familiarDir, 'out/make');

fs.rmSync(stageDir, { recursive: true, force: true });
fs.rmSync(buildDir, { recursive: true, force: true });
fs.rmSync(repoDir, { recursive: true, force: true });
fs.mkdirSync(makeDir, { recursive: true });

// Stage the manifest's source dir.
// flatpak-builder reads from a single source root; we collect the
// packaged app, the launcher, the desktop file, the AppStream xml,
// and the icon set into one staging tree.
fs.mkdirSync(path.join(stageDir, 'build'), { recursive: true });
fs.cpSync(appDir, path.join(stageDir, 'build', `Familiar-${target}`), {
  recursive: true,
});
fs.cpSync(
  path.join(flatpakDir, 'launcher.sh'),
  path.join(stageDir, 'build/launcher.sh'),
);
fs.chmodSync(path.join(stageDir, 'build/launcher.sh'), 0o755);
fs.cpSync(
  path.join(flatpakDir, 'org.endojs.Familiar.desktop'),
  path.join(stageDir, 'build/org.endojs.Familiar.desktop'),
);
fs.cpSync(
  path.join(flatpakDir, 'org.endojs.Familiar.metainfo.xml'),
  path.join(stageDir, 'build/org.endojs.Familiar.metainfo.xml'),
);
fs.mkdirSync(path.join(stageDir, 'build/icons'), { recursive: true });
for (const size of [16, 32, 64, 128, 256, 512, 1024]) {
  fs.cpSync(
    path.join(familiarDir, 'assets', `icon-${size}.png`),
    path.join(stageDir, `build/icons/icon-${size}.png`),
  );
}
fs.cpSync(
  path.join(flatpakDir, 'org.endojs.Familiar.json'),
  path.join(stageDir, 'org.endojs.Familiar.json'),
);

const pkg = JSON.parse(
  fs.readFileSync(path.join(familiarDir, 'package.json'), 'utf8'),
);
const version = pkg.version || '0.0.0';

// 1. flatpak-builder produces the build tree and exports to a local repo.
execSync(
  `flatpak-builder --force-clean --repo=${JSON.stringify(repoDir)} --arch=${arch} ${JSON.stringify(buildDir)} ${JSON.stringify('org.endojs.Familiar.json')}`,
  { stdio: 'inherit', cwd: stageDir },
);

// 2. flatpak build-bundle collapses the repo into a single .flatpak.
const bundlePath = path.join(
  makeDir,
  `Familiar-${version}-${target}.flatpak`,
);
execSync(
  `flatpak build-bundle --arch=${arch} ${JSON.stringify(repoDir)} ${JSON.stringify(bundlePath)} org.endojs.Familiar`,
  { stdio: 'inherit', cwd: stageDir },
);

console.log(`Created: out/make/${path.basename(bundlePath)}`);
```

The script is a standalone `step:build-flatpak` npm-script that runs
as its own CI step after the existing `make` step (see § Pipeline
Shape and § CI Workflow Integration), branching independently off the
step-5 packaged-app directory rather than being called from inside
`make-distributables.mjs`; the existing zip emission in `make` is
untouched.
Adding the script to `package.json`:

```json
"step:build-flatpak": "node scripts/build-flatpak.mjs",
```

### CI Workflow Integration

`familiar-release.yml`'s `make` job already runs on
`ubuntu-latest` for the Linux target.
The Flatpak step grafts onto that job:

```yaml
- name: Install Flatpak toolchain
  if: matrix.target-os == 'linux'
  run: |
    sudo apt-get update
    sudo apt-get install -y flatpak flatpak-builder
    flatpak remote-add --if-not-exists --user flathub \
      https://flathub.org/repo/flathub.flatpakrepo
    flatpak install --user --noninteractive flathub \
      org.freedesktop.Platform//24.08 \
      org.freedesktop.Sdk//24.08 \
      org.electronjs.Electron2.BaseApp//24.08

- name: Build Flatpak bundle
  # Release-gating policy (see § Release-Blocking Policy): NO
  # continue-on-error here is intentional — a Flatpak build failure
  # must fail the whole `make` job. Do not add continue-on-error to
  # silence a flaky flatpak-builder run without revisiting that policy.
  if: matrix.target-os == 'linux'
  run: yarn workspace @endo/familiar step:build-flatpak

# The metadata-validation and sandbox-engagement gates named in
# § Validation Gates and § Release-Blocking Policy run as their own
# steps here so a failure points at the file that needs the fix and,
# like the build step, blocks the make job (no continue-on-error).
- name: Validate Flatpak metadata
  if: matrix.target-os == 'linux'
  working-directory: packages/familiar/flatpak
  run: |
    appstreamcli validate org.endojs.Familiar.metainfo.xml
    desktop-file-validate org.endojs.Familiar.desktop

- name: Assert sandbox engagement (headless smoke)
  if: matrix.target-os == 'linux'
  run: |
    flatpak install --user --noninteractive --bundle \
      packages/familiar/out/make/*.flatpak
    # Launch under headless X11, reach steady state, then run the
    # zypak/bwrap confinement check from § Sandbox-Engagement
    # Assertion; a --no-sandbox fallback leaves the pgrep log empty,
    # fails this step, and blocks release.
    xvfb-run -a flatpak run org.endojs.Familiar &
    # ...wait for steady state, then the pgrep assertion (§ Sandbox-
    # Engagement Assertion) runs and exits non-zero on an empty match.

- name: Upload Flatpak bundle
  if: matrix.target-os == 'linux'
  uses: actions/upload-artifact@<pinned-sha>
  with:
    name: familiar-${{ matrix.target-os }}-${{ matrix.target-arch }}-flatpak
    path: packages/familiar/out/make/*.flatpak
```

The existing `Upload make output` step already picks the
`out/make/` directory, so the Flatpak file is also captured by it;
the dedicated `Upload Flatpak bundle` step is for the case where
the maintainer wants to download only the Flatpak from the
workflow's artifact list without the surrounding zip.

The `if-not-exists` guard on the remote add keeps the step
idempotent if the runner image already has Flathub registered.

The `release` job (which gathers all the `familiar-*` artifacts and
attaches them to a GitHub Release) needs no change; the existing
download step (`familiar-release.yml` lines 132 to 136) uses
`actions/download-artifact` with `pattern: familiar-*`, and the new
`familiar-${{ matrix.target-os }}-${{ matrix.target-arch }}-flatpak`
artifact name matches that glob.

### Signing Posture (Deferred)

Flatpak supports OpenPGP-signed repos via `flatpak build-sign` and
`flatpak build-update-repo --gpg-sign=<key>`.
The signed-repo route is the right shape if the project ever hosts
its own update repo (an "endojs Flatpak channel" parallel to a
Flathub listing).

For MVR followups, the `.flatpak` single-file bundle is the artifact;
single-file bundles are integrity-checked by the user's `flatpak
install` against their imported public key (or accepted with
`--no-gpg-verify` for one-off installs).
The signing-key story therefore parallels `familiar-release.md` (PR
[#231](https://github.com/endojs/endo-but-for-bots/pull/231))
G2 / G3: it stays out of MVR, gets a separate tracking issue for
the key-generation and key-distribution workflow, and lands when
the maintainer is ready to pursue it.

In the unsigned-bundle interim, the README documents that the
end-user installs via:

```sh
# Prerequisite: Flatpak itself. Preinstalled on Fedora and popular
# immutable distros; a one-time install elsewhere. If `flatpak` is
# absent the install commands below fail with "command not found" —
# this is the one prerequisite the end user must satisfy, and it
# replaces the per-file `chmod 4755 chrome-sandbox` + chown-to-root
# the .zip required.
sudo apt install flatpak        # Debian/Ubuntu; already present on Fedora

# One-time prerequisite: register the Flathub remote so the
# runtime, sdk, and Electron base app the bundle depends on
# resolve. Skip this line on a host that already has Flathub.
flatpak remote-add --if-not-exists --user flathub \
  https://flathub.org/repo/flathub.flatpakrepo

# Install the bundle and launch. On a desktop with GNOME Software or
# KDE Discover the end user can instead double-click the .flatpak and
# install through the GUI with no terminal at all.
flatpak install --user --bundle Familiar-0.1.0-linux-x64.flatpak
flatpak run org.endojs.Familiar
```

The `--bundle` form takes a single `.flatpak` file directly; no
repository configuration is required on the user's machine **for the
bundle itself**, but the runtime dependencies the bundle declares
(`org.freedesktop.Platform//24.08`, `org.freedesktop.Sdk//24.08`,
`org.electronjs.Electron2.BaseApp//24.08`) resolve through whichever
remote is configured, which is Flathub in the default
single-user-install case.

### Flathub Listing (Deferred)

Posting to Flathub is the right channel for non-developer Linux
users; once the manifest is settled and the icon / AppStream
metadata pass `appstreamcli validate` and `flatpak run
org.flatpak.Builder//stable` cleanly, the project submits to
`flathub/flathub` per the Flathub submission guide.
The submission process is a separate followup; for the MVR-followup
phase, the `.flatpak` bundle attached to the GitHub Release is the
delivery channel.

## Testing

### Local Build (Developer Host on Linux)

```sh
# Prerequisites (Ubuntu 24.04, Fedora 40+):
sudo apt install flatpak flatpak-builder
# or: sudo dnf install flatpak flatpak-builder

flatpak remote-add --if-not-exists --user flathub \
  https://flathub.org/repo/flathub.flatpakrepo
flatpak install --user --noninteractive flathub \
  org.freedesktop.Platform//24.08 \
  org.freedesktop.Sdk//24.08 \
  org.electronjs.Electron2.BaseApp//24.08

# Build the Electron app first, then the Flatpak.
cd packages/familiar
yarn build:app
yarn step:build-flatpak

# Install and run.
flatpak install --user --bundle \
  out/make/Familiar-0.1.0-linux-x64.flatpak
flatpak run org.endojs.Familiar
```

The launch's smoke pass: the chat window opens, the user fills the
LLM-provider form, the daemon binds its captp socket inside the
sandboxed `$XDG_RUNTIME_DIR/endo/` (per `@endo/where`'s
`whereEndoSock`; the grant is the `--filesystem=xdg-run/endo:create`
line), writes its state under the sandboxed `$XDG_STATE_HOME/endo/`,
and a message exchange round-trips.

#### Sandbox-Engagement Assertion

A bundle that silently falls back to `--no-sandbox` (the exact
failure mode this design exists to prevent) passes the
launch-and-exchange-a-message catalog above.
The smoke recipe therefore adds an explicit run-time check that
asserts the sandbox is engaged before declaring the run a pass.
On Linux under Flatpak the assertion is:

```sh
# After flatpak run org.endojs.Familiar reaches steady state, confirm
# the renderer is sandboxed via zypak / bwrap rather than running
# unconfined under --no-sandbox.
pgrep -af 'zypak-helper|bwrap' > /tmp/familiar-sandbox.log
test -s /tmp/familiar-sandbox.log \
  || { echo 'FAIL: Familiar renderer is not sandboxed' >&2; exit 1; }
```

If no `zypak-helper` or `bwrap` process is in the Familiar's process
tree the smoke fails closed; the bundle does not promote to
release-eligible.

### CI Smoke (Matches `familiar-release.md` (PR [#231](https://github.com/endojs/endo-but-for-bots/pull/231)) G16)

The G16 smoke test (build the app, launch it under a clean state
directory, exercise the form, observe the Primer tree appearing in
the host namespace) ports to the Flatpak target with one change:
the `clean state directory` step is `rm -rf
~/.var/app/org.endojs.Familiar` rather than `rm -rf
~/.local/state/endo/`, because Flatpak's per-app state isolation
relocates the XDG roots to `~/.var/app/<app-id>/{data,config,state,cache}`.

A Linux runner with `xvfb-run` (Electron under headless X11) can
host the same test the macOS G16 smoke runs.

### Validation Gates the Manifest Itself Must Pass

Before the Flatpak workflow promotes to `release`-eligible, the
build job runs:

- `flatpak-builder --user --install --force-clean ...` (the build itself).
- `appstreamcli validate org.endojs.Familiar.metainfo.xml` (catches
  AppStream schema drift before it reaches Flathub review).
- `desktop-file-validate org.endojs.Familiar.desktop` (XDG
  desktop-entry validation).

Each is a separate CI step so a failure points at the file that
needs the fix.

### Release-Blocking Policy for Flatpak Build Failure

The Flatpak build is additive to the existing `.zip` output; the
two artifacts share the `make` matrix entry for Linux but are
produced by separate steps.
The policy for a build that emits the zip but not the Flatpak
(`flatpak-builder` fails, an `appstreamcli` or `desktop-file-validate`
gate fails, the sandbox-engagement assertion fails):

- **The `make` job fails as a whole.** The Linux Flatpak failure is
  treated identically to a macOS DMG failure or a Linux zip failure:
  the `make` matrix entry's step exits non-zero and the `release` job
  does not run. The reasoning is that a Linux release that ships only
  the zip silently regresses the sandbox story this design exists to
  fix; shipping zip-only is worse than shipping nothing.

- **A red Flatpak `make` step does not block the upstream job.** The
  `build-artifacts` job (which builds the chat dist and bundles) runs
  ahead of `make` and is unaffected, so its other downstream consumers
  (the macOS `make` entries) proceed independently.

This policy is carried by the `make` job's default fail-on-step
semantics — the Flatpak steps run without `continue-on-error: true`.
Because that carrier is the *absence* of a flag, an explicit comment
marks it as deliberate at the CI step (see § CI Workflow Integration,
the `Build Flatpak bundle` step) so a later editor cannot silence a
flaky `flatpak-builder` run with a one-line `continue-on-error: true`
addition without recognizing they are inverting this release-gating
policy.

## Dependencies

| Design | Relationship |
|---|---|
| `familiar-release.md` (PR [#231](https://github.com/endojs/endo-but-for-bots/pull/231)) | Source. This document implements G4. |
| [`familiar-electron-shell.md`](familiar-electron-shell.md) | Defines the Electron-main process this manifest packages. |
| [`familiar-daemon-bundling.md`](familiar-daemon-bundling.md) | The bundled daemon + Node binary this manifest ships. |
| [`familiar-bundled-agents.md`](familiar-bundled-agents.md) | The `lal` setup and agent bundles this manifest ships. |

Out of scope (intentional):

- AppImage, `.deb`, `.rpm`, `.tar.gz` packaging
  (`familiar-release.md` (PR
  [#231](https://github.com/endojs/endo-but-for-bots/pull/231))
  G4 deferral).
- macOS code signing and notarization (G2).
- Windows signing (G3).
- Auto-update via `electron-updater` or Flatpak's own update
  channel (G6).
- A Flatpak signing key and Flathub listing (followup; see *Signing
  posture* and *Flathub listing* sections above).

## Design Decisions

- **Single-file `.flatpak` bundle over a hosted repo.**
  The bundle is one file that attaches to a GitHub Release; the
  user installs with `flatpak install --bundle <file>`.
  A hosted repo would let the user `flatpak install endojs
  Familiar` and pull updates automatically, but it requires a
  signing key and a public-facing repo URL.
  Per `familiar-release.md` (PR
  [#231](https://github.com/endojs/endo-but-for-bots/pull/231))
  G6, auto-update is deferred entirely; the bundle is the right
  shape for the defer-update posture.

- **`org.electronjs.Electron2.BaseApp` over hand-rolling
  Chromium's libraries.**
  The base app is maintained by the Electron-on-Flathub community
  and tracks each Electron major.
  Hand-rolling NSS, libdrm, libnotify, libsecret in module entries
  would add ~30 modules and a multi-hour build time.
  The base-app dependency is the standard Flathub Electron idiom;
  this is the design's own engineering judgment, not a maintainer
  directive (G4's prompt names Flatpak but says nothing about
  BaseApp versus hand-rolled libraries).

- **Manifest in JSON, not YAML.**
  Both forms are valid Flatpak inputs; the JSON form parses with
  `JSON.parse` from the build script and is the form Flathub's
  automation prefers.
  The existing Endo codebase uses JSON for `package.json`,
  `tsconfig.json`, and the deferred Forge config; the manifest
  stays consistent.

- **Narrow `finish-args` (no `--filesystem=home`, no
  `--share=ipc-host`).**
  Each permission is justified per the table above.
  Flathub's reviewers will reject a broader permission set without
  a stated need; the narrow set survives review and ships a
  meaningful sandbox to the user.

- **`launcher.sh` wraps `zypak-wrapper`.**
  The Electron-base-app ships `zypak`, which intercepts Chromium's
  `chrome-sandbox` invocations and routes them through Flatpak's
  `bwrap`.
  Without `zypak`, Electron's setuid sandbox conflicts with
  Flatpak's namespace sandbox and either falls back to
  `--no-sandbox` or refuses to launch.

- **No `--persist=.`**
  The daemon's state directory is the only load-bearing persistent
  path and it lives under `$XDG_STATE_HOME/endo/`, which Flatpak
  maps to `~/.var/app/org.endojs.Familiar/state/endo/` via the
  `--filesystem=xdg-state/endo:create` line.
  `--persist=.` would relocate state into `~/.var/app/<id>/`
  opaquely and surprise developer-mode users who expect XDG paths.

- **Cross-architecture is one matrix axis, not two manifests.**
  `flatpak-builder` takes `--arch=` and the manifest is
  arch-agnostic.
  The CI matrix can fan out to `x86_64` (today) and `aarch64`
  (when the maintainer turns it on) by adding a matrix entry; no
  per-arch manifest fork is needed.

## Phased Implementation

| Phase | Deliverable | Effort |
|---|---|---|
| 1 | Land this design (PR opens DRAFT for review). | This PR. |
| 2 | Land the manifest, launcher, desktop file, metainfo xml, and `build-flatpak.mjs` in `packages/familiar/flatpak/` and `packages/familiar/scripts/`, plus the end-user Flatpak-install section in `packages/familiar/README.md` (the unsigned-install snippet from § Signing Posture; the existing README is dev-Quick-Start-oriented with no end-user-install section today). | Day (builder dispatch). |
| 3 | Wire the CI steps into `familiar-release.yml`'s Linux job. | Day (builder dispatch). |
| 4 | Validate the bundle on a clean Linux host (Ubuntu 24.04 or Fedora 40+); iterate on `finish-args` if the daemon's runtime exercises something the table above missed. | Day (manual smoke). |
| 5 | (Followup, separate issue.) Generate a signing key, sign the bundle, and submit to Flathub. | Multi-day, dominated by Flathub review latency. |

Phases 2 to 4 fall under the `familiar-release.md` (PR
[#231](https://github.com/endojs/endo-but-for-bots/pull/231))
followups phase budget; phase 5 is post-MVR-followups.

## Known Gaps and TODOs

- [ ] Confirm the daemon's actual XDG-rooted write surface on Linux
  against `@endo/where`'s public API (`whereEndoState`,
  `whereEndoCache`, `whereEndoEphemeralState`, `whereEndoSock`).
  The current `finish-args` set covers the captp socket under
  `XDG_RUNTIME_DIR/endo/` (`whereEndoSock`/`whereEndoEphemeralState`),
  `XDG_STATE_HOME/endo/` (`whereEndoState`), and `XDG_CACHE_HOME/endo/`
  (`whereEndoCache`) — the three roots the public API maps onto today;
  if the implementation-phase smoke surfaces a daemon write under
  `XDG_DATA_HOME/endo/` or `XDG_CONFIG_HOME/endo/`, the manifest grows
  a corresponding `--filesystem=` line and the rationale joins the
  table above.
- [ ] Decide the arm64 timeline.
  The manifest supports `--arch=aarch64`; the CI matrix entry is
  one line.
  The `org.electronjs.Electron2.BaseApp` ships aarch64 builds.
  Adding the matrix entry is a builder pass when the maintainer
  wants the platform.
- [ ] Verify that the bundled Node binary executes inside the
  freedesktop runtime's glibc.
  The `nodejs.org/dist/` glibc-Linux binary is built against an
  older glibc than the runtime ships; forward-compatibility should
  hold, but the validation step is cheap and the failure mode
  (silent crash on daemon spawn) is expensive.
- [ ] Add the Flatpak smoke to the G16 packaged-build smoke test
  scaffold once it exists; today this is a manual step in the
  developer's local-build flow.

## Open Questions

1. **Should the design land on `master` or wait for the parent
   `familiar-release.md` (PR
   [#231](https://github.com/endojs/endo-but-for-bots/pull/231))
   to land first?**
   This PR bases on `llm` to keep the design discoverable in the
   roadmap branch.
   The implementation pass that turns the design into shipping code
   is a separate followup against `master`, per the role's
   "designs on `llm`, implementations on `master`" norm.
   While `familiar-release.md` is unmerged, cross-references in this
   document cite PR #231 by number rather than by repo-relative
   path; once #231 lands on `llm`, a sweep can convert the citations
   back to relative-path links.

2. **Are there `finish-args` lines the daemon needs that the
   per-permission table missed?**
   The list is built from reading `daemon-manager.js`, the `lal`
   agent's fetch surface, and `@endo/where`'s public XDG mapping
   (`whereEndoState` on `XDG_STATE_HOME`, `whereEndoCache` on
   `XDG_CACHE_HOME`, `whereEndoEphemeralState` on
   `XDG_RUNTIME_DIR`, `whereEndoSock` on the same).
   All three roots that mapping lands on today are granted in the
   manifest (`xdg-run/endo`, `xdg-state/endo`, `xdg-cache/endo`); the
   captp socket under `XDG_RUNTIME_DIR/endo/` in particular is now a
   first-class grant rather than an open gap, since Flatpak does not
   auto-expose arbitrary `$XDG_RUNTIME_DIR` subpaths.
   The remaining open surfaces are only the *speculative-not-yet-wired*
   ones deferred to their feature followups (pulseaudio, notifications,
   libsecret); the implementation-phase smoke test will surface any
   currently-exercised path the walk still missed, tracked as a TODO.

3. **Flathub listing as a followup or in the same followup sequence
   as the in-tree manifest?**
   The design positions the Flathub submission as a separate
   followup (after the signing-key story is resolved).
   If the maintainer prefers to land Flathub-ready from day one,
   the manifest and AppStream metadata are already shaped for it.

## Prompt

Per kriskowal at `designs/familiar-release.md` L205:

```
Please dispatch a builder to propose a pipeline for Flatpack.
We can defer the other packaging systems.
```
