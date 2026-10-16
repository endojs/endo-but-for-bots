# Gateway Packaging via CI

| | |
|---|---|
| **Created** | 2026-05-22 |
| **Updated** | 2026-05-23 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Proposed |
| **Depends on** | [gateway-package](gateway-package.md) |

## What is the Problem Being Solved?

[`gateway-package`](gateway-package.md) § Feature 10 names the
packaging targets (deb, rpm, Arch PKGBUILD, Dockerfile) and gives a
shape skeleton (service user `endo:endo`, `/var/lib/endo-gateway/`,
systemd unit template) but defers the actual build, signing, hosting,
and release-cadence questions to a follow-up.
This design is that follow-up.

The packaging matters because the gateway is the first piece of the
Endo system intended to run **as a long-lived system service** rather
than as a per-user developer process or a bundled Familiar component.
The maintainer directive frames the next step as:

> Please dispatch a designer to describe the next steps from
> implementing the Endo Gateway as pertaining to packaging for RPM,
> DEB &c, ideally using CI workflows.

A coherent packaging story needs:

1. A reproducible build pipeline that produces signed `.deb`, `.rpm`,
   PKGBUILD, and Docker artifacts from a single `git` tag.
2. A hosting story for the resulting artifact repositories (apt repo,
   yum repo, Arch user repository or third-party repo, Docker
   registry).
3. A release-cadence convention that ties the OS package version to
   the `@endo/gateway` npm version and to the Familiar-bundled
   variant's coordinate.
4. A signing model that keeps maintainer keys out of CI runners while
   still letting CI sign release artifacts.
5. An upgrade path that handles systemd-unit reload, configuration-
   schema migration, and on-disk state migration safely.

The existing repository already has the CI building blocks: a
`familiar-release.yml` workflow that matrix-builds desktop bundles for
macOS and Linux, a `ci.yml` that enforces lint / build / docs / tests
on every PR, and a release-tag-triggered upload pattern.
This design extends that pattern to OS packages.

## Scope

In scope:

- The packaging-CI workflow shape (matrix dimensions, job graph, build
  inputs, artifact outputs).
- Per-distribution packaging conventions (file layout, systemd unit,
  pre/post hooks, dependency declarations).
- Artifact signing (which keys, where they live, how CI reaches them).
- Artifact hosting (apt repo, yum repo, Docker registry).
- Release cadence and version-number coordination.
- Upgrade path (config and state migration, unit-file changes).

Out of scope (deferred to siblings or follow-ups):

- AWS-specific deployment automation
  ([`gateway-aws-deployment`](gateway-aws-deployment.md) picks this up).
- AWS-attuned Gateway variant (S3 CAS, Nitro Enclaves, Route53; see
  [`gateway-aws-attuned`](gateway-aws-attuned.md)).
- Windows packaging (no `.msi` / `.appx` / chocolatey).
  [`gateway-package`](gateway-package.md) § Cross-platform service
  shape names the Windows Service shape, and § Root User and Service
  CLI has `endo gateway start` register it; this design ships no
  native installer for it.
  Windows desktop users run the Familiar-bundled variant per
  [`gateway-package`](gateway-package.md) § Feature 5.
- macOS packaging (no `.pkg`, no Homebrew formula in this CI).
  Same rationale as Windows: the parent's launchd `LaunchDaemon`
  shape is installed by `endo gateway start` or the Familiar
  installer, not by a package this workflow builds.
  The `brew/` recipe in open PR endojs/endo-but-for-bots#412 is
  outside this workflow until a macOS system-service package has
  demand.
- BSD packaging (FreeBSD ports, OpenBSD pkg).
  Track demand; revisit when a maintainer steps up.
- Implementation of `@endo/gateway` itself.
  That work is the four-phase rollout in
  [`gateway-package`](gateway-package.md) § Phased Implementation;
  the CI work this design names lands alongside phase 4.

## Build Topology

The four packaging targets are **built independently** from a common
JavaScript bundle, not stacked one on top of the other.

```mermaid
flowchart TD
    src[Source tree<br/>endojs/endo monorepo] --> bundle[esbuild bundle<br/>endo-gateway.cjs<br/>+ per-arch node binary]

    bundle --> deb[debian/<br/>endo-gateway_VERSION_amd64.deb]
    bundle --> rpm[rpm/<br/>endo-gateway-VERSION.x86_64.rpm]
    bundle --> arch[arch/<br/>endo-gateway-VERSION.pkg.tar.zst]
    bundle --> docker[docker/<br/>endojs/gateway:VERSION]

    deb --> sign1[sign with apt repo key]
    rpm --> sign2[sign with yum repo key]
    arch --> sign3[record tarball sha256<br/>in PKGBUILD]
    docker --> sign4[cosign sign]

    sign1 --> aptrepo[(apt.endojs.org)]
    sign2 --> yumrepo[(rpm.endojs.org)]
    sign3 --> aurrepo[(AUR / endojs Arch repo)]
    sign4 --> registry[(ghcr.io / Docker Hub)]
```

The common bundle follows the pattern `familiar-release.yml` already
uses: an esbuild output that bundles `@endo/gateway` and its
transitive dependencies into a single `endo-gateway.cjs`, plus a
downloaded Node.js binary
([`familiar-daemon-bundling`](familiar-daemon-bundling.md) is the
reference pattern).
The bundle's entry point imports `@endo/init` first, so SES
`lockdown()` runs before any module that calls `harden` is
evaluated; esbuild preserves that import order in the single file.
The bundle job downloads **one Node.js binary per architecture**
(`linux-x64` and `linux-arm64`) at a single pinned patch version,
verified against that release's signed `SHASUMS256.txt`.
Every target installs the binary for its own architecture at
`/usr/lib/endo-gateway/node` next to
`/usr/lib/endo-gateway/endo-gateway.cjs`; `/usr/bin/endo-gateway` is
a two-line launcher that `exec`s the one with the other.
Each packaging job stages that bundle into the distribution's expected
layout, runs the distribution's build tool, and signs the result.

Three reasons drive the independent-build choice: portability
across distributions, blast-radius containment of signing-key
failures, and shape difference between OS packages and container
images.

- **Portability.** The distributions have different conventions for
  filesystem layout, pre/post hooks, and dependency declarations;
  the per-distribution packaging files are not derivable from one
  another.
- **Blast-radius containment.** A failure in one packaging job
  should not block the others. An apt-repo signing-key outage
  should not delay an rpm release.
- **Shape difference.** The Docker image is fundamentally a
  different artifact shape (a container image, not an OS package);
  building it from the same bundle stream rather than from a
  packaged `.deb` keeps it independent of any Debian-specific bug.

Common across all four:

- Same `@endo/gateway` source tree, same git tag, same Node.js
  version pin (one per-architecture binary of that version, not one
  binary).
  The Docker image copies the same per-arch binary from the bundle
  rather than inheriting Node.js from a floating base image (see
  § Docker).
- Same systemd unit template (per
  [`gateway-package`](gateway-package.md) § Feature 10 sketch).
- Same data directory layout
  (`/var/lib/endo-gateway/`, `/run/endo-gateway/`,
  `/etc/endo-gateway/`).

## CI Workflow Shape

A new workflow file `.github/workflows/gateway-release.yml` mirrors
the `familiar-release.yml` shape: tag-triggered, matrix-build, signed
artifact upload.

```yaml
name: Gateway Release

on:
  workflow_dispatch:
    inputs:
      version:
        description: 'Release version, strict semver (for example 0.1.0)'
        required: false
        type: string
  push:
    tags:
      - 'gateway-v*'

permissions:
  contents: write
  packages: write    # for ghcr.io push
  id-token: write    # for cosign keyless signing

jobs:
  bundle:
    name: Build bundle
    runs-on: ubuntu-latest
    outputs:
      version: ${{ steps.version.outputs.version }}
      prerelease: ${{ steps.version.outputs.prerelease }}
    steps:
      # checkout with fetch-depth: 0 (the ancestry check needs history)
      # id: version -- resolve and validate VERSION (§ Triggers):
      #   tag push: VERSION="${GITHUB_REF_NAME#gateway-v}", then
      #     git merge-base --is-ancestor "$GITHUB_SHA" origin/master
      #   dispatch: VERSION="${{ inputs.version }}" (passed via env:,
      #     never interpolated into the script text)
      #   both: fail unless VERSION matches
      #     ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$
      #   prerelease=true when VERSION carries a -suffix
      # corepack + pinned Node 22.x (>= 22.13) + yarn install --immutable
      # yarn workspace @endo/gateway step:bundle
      # download linux-x64 and linux-arm64 node binaries, check SHASUMS256
      # upload bundle artifact

  # One packaging job per target, each its own (per-arch) matrix,
  # so a target's failure fails only that target's job.
  package-deb:
    needs: bundle
    strategy:
      fail-fast: false
      matrix:
        include:
          - { runner: ubuntu-latest,    arch: amd64 }
          - { runner: ubuntu-24.04-arm, arch: arm64 }
    runs-on: ${{ matrix.runner }}
    steps:
      # download bundle artifact
      # run packages/gateway/packaging/debian/build-deb.sh
      # sign, upload signed artifact

  package-rpm:
    needs: bundle
    strategy:
      fail-fast: false
      matrix:
        include:
          - { runner: ubuntu-latest,    arch: x86_64 }
          - { runner: ubuntu-24.04-arm, arch: aarch64 }
    runs-on: ${{ matrix.runner }}
    steps:
      # download bundle artifact
      # run packages/gateway/packaging/rpm/build-rpm.sh
      # sign, upload signed artifact

  package-arch:
    needs: bundle
    runs-on: ubuntu-latest
    steps:
      # download bundle artifact, render PKGBUILD (substitute
      # __VERSION__ and the sha256), fail if 'SKIP' remains, upload

  package-docker:
    needs: bundle
    runs-on: ubuntu-latest
    outputs:
      digest: ${{ steps.build.outputs.digest }}
    steps:
      # buildx multi-arch (amd64, arm64), push by digest, cosign sign

  # One publish job per target, each depending only on its own
  # package job. An apt signing failure skips publish-apt and nothing
  # else.
  publish-apt:
    needs: package-deb
    if: startsWith(github.ref, 'refs/tags/gateway-v')
    runs-on: ubuntu-latest
    steps:
      # push deb to apt repo

  publish-rpm:
    needs: package-rpm
    if: startsWith(github.ref, 'refs/tags/gateway-v')
    runs-on: ubuntu-latest
    steps:
      # push rpm to yum repo

  publish-aur:
    needs: package-arch
    if: startsWith(github.ref, 'refs/tags/gateway-v')
    runs-on: ubuntu-latest
    steps:
      # push PKGBUILD update to AUR

  publish-docker:
    needs: [bundle, package-docker]
    if: startsWith(github.ref, 'refs/tags/gateway-v')
    runs-on: ubuntu-latest
    steps:
      # tag the pushed digest as VERSION on ghcr.io; also as latest
      # only when needs.bundle.outputs.prerelease == 'false'

  release:
    needs: [publish-apt, publish-rpm, publish-aur, publish-docker]
    # Run even when some publish jobs failed or were skipped, so the
    # release records exactly which targets shipped.
    if: ${{ always() && startsWith(github.ref, 'refs/tags/gateway-v') }}
    runs-on: ubuntu-latest
    steps:
      # create GitHub Release, attach every artifact that was built,
      # and list per-target publish status (shipped / failed / skipped)
      # in the release notes
```

### Partial-release semantics

Each target's path is `package-<target>` then `publish-<target>`, and
no target's path depends on another's.
A tag push therefore yields a **partial release** when some targets
fail: the targets whose package and publish jobs succeeded are
published, and the failed targets are not.
The final `release` job runs regardless (`always()`), creates the
GitHub Release, and records per-target status in the release notes,
so a reader can tell "rpm 0.1.0 shipped, apt 0.1.0 did not" without
reading CI logs.
The workflow run as a whole still reports failure, which is the
maintainer's signal to fix the failed target and re-run only its
failed jobs (`gh run rerun --failed`) against the same tag.
Re-running is safe because each publish step is written to be
idempotent for a given version: it first checks whether that version
is already present in its repository or registry and skips the push
if so.
Within a single target, the architectures publish together:
`publish-apt` waits for both deb legs, so the apt repository never
advertises a version for amd64 that is missing for arm64.

### Matrix dimensions

| Dimension | Values | Rationale |
|-----------|--------|-----------|
| Target | deb, rpm, arch, docker | The four packaging targets named by the parent design. |
| Architecture | amd64 / x86_64, arm64 / aarch64 | The two architectures that cover modern server fleets. Arch user repo skips arm64 (AUR convention; Arch ARM is a separate distribution). |
| Node.js LTS | One patch-version pin per gateway release (today: a 22.x release >= 22.13.0, for `node:sqlite`) | Following the maintainers' Node.js LTS-window cadence (each gateway release tracks the active LTS line); the gateway pins one LTS at build time and CI matrix-tests the supported range elsewhere (`ci.yml`). |

The package jobs produce **7 artifacts per release**: 2 deb (amd64, arm64),
2 rpm (x86_64, aarch64), 1 PKGBUILD (Arch x86_64 only), 2 Docker tags
(amd64 and arm64, combined into a multi-arch manifest).
Each artifact carries the same version string and the same Node.js
version, bundled as the binary for its own architecture.

### Triggers

- **Tag push** `gateway-v<semver>`: full pipeline runs and publishes
  artifacts.
  The `gateway-v*` filter is only a coarse match, so the `bundle` job
  strips the `gateway-v` prefix to get `VERSION` and fails the run
  unless `VERSION` is strict semver (`MAJOR.MINOR.PATCH` with an
  optional `-pre-release` suffix, no `+build` metadata).
  It also fails unless the tagged commit is an ancestor of `master`
  (`git merge-base --is-ancestor "$GITHUB_SHA" origin/master`), which
  is the mechanism behind "release tags are cut from `master`".
  Every artifact name and the Docker tag use the stripped `VERSION`
  (`0.1.0`, not `gateway-v0.1.0`).
  A pre-release `VERSION` (`0.2.0-rc.1`) publishes under its own
  version but never moves Docker `:latest` or the apt / yum `stable`
  channel.
- **Manual dispatch with `version` input**: the input goes through
  the same semver check before it is substituted into `__VERSION__`
  or any file name, then the workflow builds the artifacts and
  attaches them to a *draft* GitHub Release without publishing to
  the apt / yum / AUR / docker registries.
  This is the staging path: a maintainer dispatches a build, smoke-
  tests the artifacts locally, then re-runs with the actual tag.
- **PR**: a `package-smoke` job in `ci.yml` builds the deb and the
  Docker image without signing or publishing, to catch packaging
  regressions before they reach a release.
  The smoke job runs on every PR that touches `packages/gateway/`
  (which includes `packages/gateway/packaging/`) or
  `.github/workflows/gateway-release.yml`.

## Per-Distribution Conventions

The recipes live under `packages/gateway/packaging/`, one
subdirectory per target (`debian/`, `rpm/`, `arch/`, `docker/`), the
location open PR endojs/endo-but-for-bots#412 already uses.
This supersedes the top-level `packaging/{deb,rpm,arch,docker}/`
named in [`gateway-package`](gateway-package.md) § Feature 10, so
the recipes version with the package they ship and there is one
tree, not two.

### What the package guarantees

The four distribution packages diverge in their *idiomatic*
post-install hooks (Debian's `adduser --system --group`, RHEL's
`useradd --system`, Arch's `endo-gateway.install`) but converge
on the same post-install invariants. The hook is implementation
detail; the table below pins the invariant the operator can rely
on regardless of distribution:

| Invariant | Value |
|-----------|-------|
| System user | `endo` (no login shell, no home directory creation) |
| System group | `endo` |
| State directory | `/var/lib/endo-gateway/`, mode `0750`, owner `endo:endo` |
| Cache directory | `/var/cache/endo-gateway/`, mode `0750`, owner `endo:endo` |
| Runtime directory | `/run/endo-gateway/`, mode `0750`, owner `endo:endo` (created by systemd's `RuntimeDirectory=`) |
| Config directory | `/etc/endo-gateway/`, mode `0750`, owner `root:endo` (traversable by the `endo` group) |
| Config files | `/etc/endo-gateway/*.toml`, mode `0640`, owner `root:endo` |
| systemd unit | `endo-gateway.service`, enabled (deb / rpm) or operator-enabled (Arch / Docker), not started by default |

Each per-distribution hook below lands these same invariants
through its idiomatic mechanism.

These are the same paths and modes
[`gateway-package`](gateway-package.md) § Root User and Service CLI
lists for the system gateway, and the unit is the one sketched in
§ Feature 10 (`Type=notify`, `RuntimeDirectory=`, `StateDirectory=`,
`CacheDirectory=`, `LogsDirectory=`).
On a packaged host, `endo gateway start` verifies the packaged unit
rather than writing its own, then runs `systemctl enable --now`;
`endo gateway stop` and `endo gateway log` map to `systemctl stop`
and `journalctl -u endo-gateway.service -f` as the parent describes.
The package does not start the service itself; the operator starts
it after editing the config, with either `endo gateway start` or
`systemctl start`.

### Debian / Ubuntu (`.deb`)

Layout under `packages/gateway/packaging/debian/`:

```
packages/gateway/packaging/debian/
  debian/
    changelog                # generated from git tag history
    control                  # package metadata, dependencies
    rules                    # build orchestration (debhelper)
    postinst                 # post-install: useradd, systemctl enable
    prerm                    # pre-remove: systemctl stop, disable
    postrm                   # post-remove: purge state on --purge
    endo-gateway.service     # systemd unit
    endo-gateway.default     # /etc/default/endo-gateway template
  build-deb.sh               # called by CI; runs dpkg-buildpackage
```

Dependencies declared in `debian/control`:

```
Package: endo-gateway
Architecture: amd64 arm64
Depends: ${shlibs:Depends}, ${misc:Depends}, adduser, systemd
Recommends: nginx | caddy | apache2 | traefik
Description: Endo Gateway: HTTP+OCapN service for the Endo distributed
 capability system. Provides virtual hosting, Git over HTTP, an
 OCapN-Noise WebSocket subprotocol, and a UDS bootstrap for local
 CapTP relay registration.
```

The `Recommends:` line lists the HTTPS terminating proxies that
[`gateway-package`](gateway-package.md) § Feature 9 expects; the
operator picks one. Debian's `|` (space-pipe-space) syntax in the
`Recommends:` field means apt installs the first available
alternate from the list; the operator's choice surfaces during
`apt install` selection rather than requiring them to edit the
control file.

Post-install hook (`debian/postinst`):

```bash
#!/bin/sh
set -e
case "$1" in
  configure)
    # Create the system user if it does not exist.
    if ! getent passwd endo > /dev/null; then
      adduser --system --group --home /var/lib/endo-gateway \
        --no-create-home --shell /usr/sbin/nologin endo
    fi
    # Ensure state and runtime directories exist with the right mode.
    install -d -o endo -g endo -m 0750 /var/lib/endo-gateway
    install -d -o endo -g endo -m 0750 /var/cache/endo-gateway
    install -d -o root -g endo -m 0750 /etc/endo-gateway
    # Enable but do not start; the operator starts after editing config.
    deb-systemd-helper enable endo-gateway.service
    ;;
esac
#DEBHELPER#
exit 0
```

The `--no-create-home` plus the explicit `install -d` separates the
user creation from the directory permissions, so a re-run of
`postinst` on an existing install does not clobber the operator's
filesystem-level customizations.

### RHEL / Fedora (`.rpm`)

Layout under `packages/gateway/packaging/rpm/`:

```
packages/gateway/packaging/rpm/
  endo-gateway.spec
  endo-gateway.service       # systemd unit (as the .deb, but with
                             # EnvironmentFile=-/etc/sysconfig/endo-gateway)
  endo-gateway.sysconfig     # /etc/sysconfig/endo-gateway template
  build-rpm.sh               # called by CI; runs rpmbuild
```

The `.spec` file:

```spec
Name:     endo-gateway
Version:  %{_gateway_version}
Release:  1%{?dist}
Summary:  Endo Gateway: HTTP+OCapN service for Endo
License:  Apache-2.0
URL:      https://github.com/endojs/endo

BuildArch: %{_arch}
Requires:  systemd shadow-utils

%description
Endo Gateway provides virtual hosting, Git over HTTP, an OCapN-Noise
WebSocket subprotocol, and a UDS bootstrap for local CapTP relay
registration.

%pre
getent passwd endo > /dev/null || \
  useradd --system --no-create-home --home-dir /var/lib/endo-gateway \
          --shell /sbin/nologin endo

%post
%systemd_post endo-gateway.service

%preun
%systemd_preun endo-gateway.service

%postun
%systemd_postun_with_restart endo-gateway.service

%files
%attr(0755, root, root) /usr/bin/endo-gateway
%attr(0755, root, root) /usr/lib/endo-gateway/node
%attr(0644, root, root) /usr/lib/endo-gateway/endo-gateway.cjs
%dir %attr(0750, endo, endo) /var/lib/endo-gateway
%dir %attr(0750, endo, endo) /var/cache/endo-gateway
%dir %attr(0750, root, endo) /etc/endo-gateway
%attr(0644, root, root) /usr/lib/systemd/system/endo-gateway.service
%config(noreplace) /etc/sysconfig/endo-gateway
```

The `%config(noreplace)` flag preserves the operator's edits to
`/etc/sysconfig/endo-gateway` on upgrade; the spec file's defaults
land as `.rpmnew` files alongside.

### Arch (`PKGBUILD`)

Layout under `packages/gateway/packaging/arch/`:

```
packages/gateway/packaging/arch/
  PKGBUILD
  endo-gateway.install       # pre/post hooks
  endo-gateway.service       # systemd unit
```

The `PKGBUILD`:

```bash
pkgname=endo-gateway
pkgver=__VERSION__       # CI substitutes at build time
pkgrel=1
pkgdesc='Endo Gateway: HTTP+OCapN service for Endo'
arch=('x86_64')
url='https://github.com/endojs/endo'
license=('Apache-2.0')
depends=('systemd')
backup=('etc/endo-gateway/config.toml')
install='endo-gateway.install'
source=("https://github.com/endojs/endo/releases/download/gateway-v${pkgver}/endo-gateway-${pkgver}.tar.gz")
sha256sums=('__SHA256__')  # CI substitutes the tarball's sha256

package() {
  cd "${srcdir}/endo-gateway-${pkgver}"
  install -Dm0755 endo-gateway "${pkgdir}/usr/bin/endo-gateway"
  install -Dm0755 node "${pkgdir}/usr/lib/endo-gateway/node"
  install -Dm0644 endo-gateway.cjs \
    "${pkgdir}/usr/lib/endo-gateway/endo-gateway.cjs"
  install -Dm0644 endo-gateway.service \
    "${pkgdir}/usr/lib/systemd/system/endo-gateway.service"
  install -Dm0640 config.toml.example \
    "${pkgdir}/etc/endo-gateway/config.toml.example"
}
```

The `package-arch` job substitutes `__VERSION__` (after the semver
check in § Triggers) and `__SHA256__` (computed from the release
tarball it uploads), then fails if `__VERSION__`, `__SHA256__`, or
`SKIP` remains anywhere in the rendered `PKGBUILD`.
A `SKIP` checksum would let `makepkg` install whatever the source URL
serves, so it must never reach the AUR.

Arch ARM (the separate distribution for ARM hardware) is not in scope
for the first cut; the AUR convention prioritizes `x86_64` first, and
downstream ARM repackagers handle their own platforms when AUR
packages do not ship multi-arch.

The PKGBUILD lands in the AUR under the bot identity (`endojs` AUR
account; the maintainer creates and grants the bot access at release
time).
Tag-triggered CI pushes the updated `PKGBUILD` via SSH to the AUR
git remote.

### Docker

Layout under `packages/gateway/packaging/docker/`:

```
packages/gateway/packaging/docker/
  Dockerfile
  docker-entrypoint.sh
  config.toml.example
```

The `Dockerfile`:

```dockerfile
# Pinned by digest; Node.js comes from the bundle, not the base image.
FROM debian:bookworm-slim@sha256:<pinned-digest> AS runtime
ARG TARGETARCH

# UID/GID of the in-container service account. Overridable at build
# time so the image can match the ownership of host volumes; the
# default sits outside the range commonly used for interactive
# accounts (UID 1000 and up).
ARG ENDO_UID=10001
ARG ENDO_GID=10001

RUN groupadd --system --gid "${ENDO_GID}" endo && \
    useradd --system --uid "${ENDO_UID}" --gid endo --no-create-home \
    --home-dir /var/lib/endo-gateway \
    --shell /usr/sbin/nologin endo && \
    mkdir -p /var/lib/endo-gateway /var/cache/endo-gateway \
             /run/endo-gateway /etc/endo-gateway && \
    chown -R endo:endo /var/lib/endo-gateway /var/cache/endo-gateway \
                       /run/endo-gateway && \
    chown root:endo /etc/endo-gateway && \
    chmod 0750 /etc/endo-gateway

COPY --chown=root:endo --chmod=0640 packages/gateway/packaging/docker/config.toml.example \
     /etc/endo-gateway/config.toml.example
COPY --chown=root:endo --chmod=0640 packages/gateway/packaging/docker/config.toml.example \
     /etc/endo-gateway/config.toml

USER endo
WORKDIR /var/lib/endo-gateway

COPY --chown=root:root --chmod=0755 bundles/node-${TARGETARCH} \
     /usr/lib/endo-gateway/node
COPY --chown=root:root --chmod=0644 bundles/endo-gateway.cjs \
     /usr/lib/endo-gateway/endo-gateway.cjs
COPY --chown=root:root --chmod=0755 packages/gateway/packaging/docker/docker-entrypoint.sh \
     /usr/lib/endo-gateway/entrypoint.sh

VOLUME /var/lib/endo-gateway
VOLUME /etc/endo-gateway
EXPOSE 8920

ENV ENDO_HTTP_ADDR=0.0.0.0:8920
ENTRYPOINT ["/usr/lib/endo-gateway/entrypoint.sh"]
CMD ["/usr/lib/endo-gateway/node", "/usr/lib/endo-gateway/endo-gateway.cjs"]
```

The image copies the bundle job's per-architecture Node.js binary
(`bundles/node-amd64` or `bundles/node-arm64`, selected by buildx's
`TARGETARCH`) instead of starting `FROM node:22-slim`, so the
container runs exactly the Node.js patch version the deb, rpm, and
Arch packages run, and a base-image rebuild cannot change it.
The base image is pinned by digest and bumped deliberately.
The port is the parent's HTTP default, 8920
([`gateway-package`](gateway-package.md) Design Decision 2; 3469 is
reserved there for a future CBOR-frame transport).
The bundle, binary, and entrypoint are root-owned, read-only to
`endo`, and outside the state volume, so a bind mount over
`/var/lib/endo-gateway` cannot hide them.

The service account's UID and GID are the build arguments
`ENDO_UID` and `ENDO_GID`, both defaulting to `10001`.
The default deliberately avoids UID `1000`, which commonly belongs to
the first interactive account on a host (and to the `node` user in
the official `node` images).
Volume ownership follows the same numbers:

- **Named volumes** are seeded from the image on first mount, so they
  inherit `endo:endo` (state) and `root:endo` (config) ownership with
  no operator action.
- **Bind mounts** must be owned by the image's UID/GID: either
  `chown -R 10001:10001` the host state directory (and
  `chown -R 0:10001` the config directory), or rebuild the image with
  `--build-arg ENDO_UID=<uid> --build-arg ENDO_GID=<gid>` to match an
  existing host account.
  The published `ghcr.io/endojs/gateway` image always uses the
  documented default.

The config directory stays `root:endo`, mode `0750`, matching the
package invariant: the gateway reads its config but cannot rewrite it.
The image therefore bakes a default `config.toml` at build time rather
than having the entrypoint (running as `endo`) write one.
The entrypoint only checks that a config is present, which catches an
empty bind mount, then `exec`s the gateway:

```bash
#!/bin/sh
set -eu
if [ ! -r /etc/endo-gateway/config.toml ]; then
  echo "endo-gateway: /etc/endo-gateway/config.toml is missing or unreadable;" >&2
  echo "provide one in the mounted config directory (see /etc/endo-gateway/config.toml.example in the image)." >&2
  exit 78
fi
exec "$@"
```

Multi-arch build via `docker buildx` in `package-docker`, pushing by
digest only (no tags), then tagging in `publish-docker`:

```yaml
# package-docker
- name: Set up Docker Buildx
  uses: docker/setup-buildx-action@v3
- name: Build and push by digest (multi-arch)
  id: build
  uses: docker/build-push-action@v6
  with:
    context: .
    file: packages/gateway/packaging/docker/Dockerfile
    platforms: linux/amd64,linux/arm64
    outputs: type=image,name=ghcr.io/endojs/gateway,push-by-digest=true,push=true
    cache-from: type=gha
    cache-to: type=gha,mode=max

# publish-docker (VERSION is the validated, prefix-stripped semver)
- name: Tag the digest
  env:
    VERSION: ${{ needs.bundle.outputs.version }}
    PRERELEASE: ${{ needs.bundle.outputs.prerelease }}
    DIGEST: ${{ needs.package-docker.outputs.digest }}
  run: |
    tags="-t ghcr.io/endojs/gateway:$VERSION"
    if [ "$PRERELEASE" = false ]; then
      tags="$tags -t ghcr.io/endojs/gateway:latest"
    fi
    docker buildx imagetools create $tags "ghcr.io/endojs/gateway@$DIGEST"
```

The Docker tag is `0.1.0`, never `gateway-v0.1.0`, and only a
non-pre-release version moves `:latest`.

The Docker image is pushed to **`ghcr.io/endojs/gateway`** (the
project's existing GitHub Container Registry namespace) by default.
A mirror to Docker Hub is configurable but not the default; the
maintainer's docker-hub credentials would need to land in CI secrets,
which is the kind of authorization the boatman gates per the standard
identity-switch flow.

## Signing Model

| Artifact | Key | Storage | Used by |
|----------|-----|---------|---------|
| `.deb` | Repository signing key (gpg, RSA 4096) | GitHub Secrets `APT_REPO_SIGNING_KEY` | `aptly publish` step at release time |
| `.rpm` | Repository signing key (gpg, RSA 4096) | GitHub Secrets `YUM_REPO_SIGNING_KEY` | `rpmsign --resign` step at release time |
| PKGBUILD | No signing key; integrity is the source tarball's sha256 in the published `PKGBUILD` (AUR convention) | n/a (the template carries `__SHA256__`; CI substitutes the real digest and fails if `SKIP` or a placeholder survives) | `package-arch` job at build time |
| Docker | Sigstore cosign keyless signature | GitHub OIDC token (no long-lived key) | `cosign sign` step after image push |

### Repository keys vs. maintainer keys

The `.deb` and `.rpm` repository keys are **repository keys**, not the
maintainer's personal key.
The repository key signs the *repository metadata* (the `Release` file
in apt, the `repomd.xml` in yum); clients trust the key, then the
metadata names the per-package sha256 sums, then the per-package
signature (if any) is verified against the package itself.
Compromising the repository key compromises the integrity of the
repository contents but does not impersonate the maintainer's
identity for non-repository purposes (commit signing, ferry pushes
under kriskowal credentials).

The repository keys are generated **once at repo bootstrap** and live
in GitHub Secrets as armored private keys.
Rotation is via the standard apt / yum trusted-key replacement: ship
a new repository key alongside the old one for one release cycle, then
remove the old one.

The Docker image uses **sigstore keyless** signing: the GitHub Actions
runner authenticates to Sigstore's Fulcio with its OIDC token, gets a
short-lived signing certificate, and signs the image with it.
The Rekor transparency log records the signature; consumers verify
with `cosign verify --certificate-identity-regexp` against the
expected workflow identity.
No long-lived signing key is stored anywhere; the OIDC chain plus the
transparency log substitutes.

**Why the asymmetry between Docker and apt / yum.** Docker's
sigstore-keyless path works because the OCI ecosystem has the
Fulcio OIDC chain plus the Rekor transparency log as the
client-side verification primitive: `cosign verify` accepts a
short-lived certificate keyed to a workflow identity, and the
transparency log makes the issuance auditable. apt and yum
clients do *not* have an analogous transparency-log verification
primitive; they verify against a published repository public key
embedded in the client's trust store. A "no long-lived signing
key anywhere" shape on apt / yum would require either
short-lived per-release keys (which would force every consumer
to re-trust on every release) or a transparency-log integration
that does not exist in apt / yum today. The asymmetry is
structural to the per-ecosystem tooling, not a choice this
design made; the repo-key shape on apt / yum is the right
fit for what those clients support.

### Why not the maintainer's personal GPG key?

The maintainer's personal GPG key (`kriskowal`) signs commits on the
canonical `endojs/endo` repository and is used by the boatman to ferry
PRs upstream.
Putting that key in CI secrets would widen the blast radius of any CI
compromise to include the maintainer's commit identity on every repo
they touch.
Repository-only keys keep the scope tight.

### Open question: keyring distribution

Where does the apt repository's public key live for *first contact* by
a Debian user?

Options:

1. `apt-key add` via `curl https://apt.endojs.org/key.gpg | sudo apt-key add -`.
   (Deprecated by Debian; modern apt rejects this.)
2. A signed-by directive in the user's `sources.list`:
   `deb [signed-by=/usr/share/keyrings/endojs.gpg] https://apt.endojs.org stable main`.
   The keyring file ships separately, downloaded once.
3. A small `endo-apt-keyring` package shipped *unsigned* via a parallel
   bootstrap repository.
   (Awkward; a chicken-and-egg shape.)

Surfaced rather than picked.
The likely answer is (2), matching modern Debian convention.

## Artifact Hosting

### Apt repository (`apt.endojs.org`)

A static apt repository generated by `aptly` on tag push, hosted on
**S3 + CloudFront** (the sibling design
[`gateway-aws-deployment`](gateway-aws-deployment.md) covers the AWS
side).
Until that AWS infrastructure lands, the bootstrap host is **GitHub
Pages** at `https://endojs.github.io/apt-repo/`, indexed via a small
`apt.endojs.org` CNAME.

Layout:

```
apt.endojs.org/
  dists/
    stable/
      main/
        binary-amd64/
          Packages
          Packages.gz
        binary-arm64/
          Packages
          Packages.gz
      Release
      Release.gpg
      InRelease
  pool/
    main/
      e/
        endo-gateway/
          endo-gateway_0.1.0_amd64.deb
          endo-gateway_0.1.0_arm64.deb
```

The release workflow runs `aptly repo add`, `aptly publish update`,
then `aws s3 sync` (or `git push gh-pages` during the bootstrap
phase).

### Yum repository (`rpm.endojs.org`)

A static yum repository generated by `createrepo_c` on tag push,
same hosting story as apt.

```
rpm.endojs.org/
  endo-gateway/
    x86_64/
      endo-gateway-0.1.0-1.el9.x86_64.rpm
      repodata/
        repomd.xml
        repomd.xml.asc
    aarch64/
      ...
```

A `endo-gateway.repo` file at the repo root lets users install with:

```sh
sudo dnf config-manager --add-repo https://rpm.endojs.org/endo-gateway.repo
sudo dnf install endo-gateway
```

### Arch (AUR)

The PKGBUILD lives in the AUR under the `endo-gateway` package name.
The CI workflow pushes updates to the AUR via SSH on tag push.
Users install with their AUR helper of choice (`yay`, `paru`, etc.).

### Docker (`ghcr.io/endojs/gateway`)

Push to GitHub Container Registry on tag push, tagged with the
prefix-stripped version, plus `latest` for non-pre-release versions.
A multi-arch manifest lets `docker pull ghcr.io/endojs/gateway:latest`
work transparently on amd64 and arm64 hosts.

## Release Cadence

### Version coordinate

The OS package version **matches** the `@endo/gateway` npm package
version exactly.
A release of `@endo/gateway@0.1.0` produces:

- `endo-gateway_0.1.0_amd64.deb`
- `endo-gateway-0.1.0-1.fc40.x86_64.rpm`
- `endo-gateway 0.1.0-1` (Arch)
- `ghcr.io/endojs/gateway:0.1.0`

The git tag is `gateway-v0.1.0`, matching the `familiar-v*` tag
convention; every artifact uses the version with the `gateway-v`
prefix stripped (§ Triggers).
A pre-release such as `0.2.0-rc.1` keeps that string for the npm
version and Docker tag, and becomes `0.2.0~rc.1` in the deb, rpm, and
Arch versions so the package managers sort it before `0.2.0`.

The Familiar-bundled variant
([`gateway-package`](gateway-package.md) § Feature 5) carries the same
`@endo/gateway` version as its dependency in the Familiar's bundle;
Familiar releases name the gateway version in the release notes.

### Frequency

The first cut is **on-demand, maintainer-tagged**.
Once the gateway lands in the wild and a regular cadence is justified,
move to a monthly release on the last Tuesday of each month (the
established pattern for upstream Linux distribution packages).
Pinning the cadence here is premature; the design records where it
would change.

### Channels

Two channels in the apt and yum repositories:

- `stable` (default): tagged releases.
- `nightly` (opt-in): built nightly from `master` HEAD, version
  `0.0.0-nightly.YYYYMMDD.SHA`.

The nightly channel is for developers and integrators; the stable
channel is for production deployments.
Both go through the same packaging matrix; the nightly job is a
scheduled-cron variant of the release workflow that skips the GitHub
Release upload.

## Upgrade Path

### systemd unit reload

The gateway is **not designed to hot-reload** in the first cut.
A package upgrade triggers `systemctl restart endo-gateway.service`
via the package's post-upgrade hook (`%systemd_postun_with_restart`
on rpm, `dh_installsystemd --restart-after-upgrade` on deb).

A graceful-restart story (drain in-flight requests, hand-off the
listening socket to the new process via `systemd`'s socket-activation
mechanism) is **deferred** to a follow-up design once the gateway has
real production traffic.
Surfaced as Open Question 3 below.

### Configuration migration

The configuration file at `/etc/endo-gateway/config.toml` carries a
top-level `schema_version` field.
The gateway reads it on startup and applies migration shims for older
schema versions up to the current.
The package install lays down a `config.toml.example` reflecting the
current schema; the operator merges by hand on schema changes (a
config-conflict marker file at `/etc/endo-gateway/config.toml.dpkg-dist`
or `.rpmnew`).

A future `endo-gateway config migrate` subcommand would automate
the merge; deferred to follow-up.

### State migration

The gateway's on-disk state at `/var/lib/endo-gateway/` carries a
**state version** in `/var/lib/endo-gateway/STATE_VERSION` (a single
integer).
The gateway refuses to start if `STATE_VERSION` is higher than its
own (forward-incompatible downgrade) or if a downward migration step
is missing.
Upward migrations run automatically on startup, recording each step
to a `migrations.log` adjacent to the state.

State here follows [`gateway-package`](gateway-package.md)
§ Restart semantics: the gateway persists operator policy files, the
sqlite weblet-formula table, and the CAS cache, while the
registration table is rebuilt from incoming user-daemon registrations
on every start and is never persisted, so it has nothing to migrate.
`STATE_VERSION` covers `state.db`; the CAS cache under
`/var/cache/endo-gateway/` is reconstructible, so a cache-layout change
discards and refills it rather than migrating it.

The per-account resource ledger also lives in the gateway
([`gateway-package`](gateway-package.md) Design Decision 8: a
`ResourceLedger` exo with `getBalance`, `chargeBalance`, and
`purchaseTokens`, per § Feature 1 and § Capability Surface), and its
plumbing lands in the parent's Phase 2.
The parent fixes that method surface but not the ledger's storage
tables, and Open Question 1 there defers the payment-token mechanism.
When the Feature 1 implementation defines those tables, they go in
`state.db` under the same `PRAGMA user_version` migrations below.
Unlike the cache, balances are not reconstructible, so ledger tables
are migrated in place and covered by the state backup, never
discarded.

### sqlite (or sibling) database

The gateway's persistent tables back onto a local sqlite file at
`/var/lib/endo-gateway/state.db` for the first cut.
Sqlite's `PRAGMA user_version` carries the schema version; the
gateway's startup-time migration step bumps it through registered
migrations.

The binding is Node.js's built-in **`node:sqlite`** (`DatabaseSync`).
It is unflagged from Node.js 22.13.0, so `@endo/gateway` declares
`"engines": { "node": ">=22.13.0" }`, narrower than the monorepo
root's `^20.17.0 || >=22.9.0`, and the pinned bundled Node.js
(§ Matrix dimensions) must satisfy it.
Any Node.js 20 CI leg (for example the 20.17.x job in
`ocapn-guile-interop.yml`) cannot load the gateway and must not run
its tests.
A native addon such as `better-sqlite3` was rejected because a `.node`
binary cannot be inlined into the single `endo-gateway.cjs`; it would
have to ship per architecture beside the bundle and load through a
filesystem path, which breaks the one-file bundle shape.
The AWS-attuned variant
([`gateway-aws-attuned`](gateway-aws-attuned.md)) replaces sqlite with
a cloud-native equivalent (DynamoDB, Aurora Serverless, or RDS
Postgres); that swap is invisible to the packaging layer because the
state-store abstraction lives in `@endo/gateway`'s code, not in the
package's filesystem layout.

## Dependencies

| Design | Relationship |
|--------|--------------|
| [gateway-package](gateway-package.md) | **Parent design.** Feature 10 (OS packaging) names the shape; this design picks the build topology, signing model, hosting, cadence, and upgrade path. |
| [gateway-bearer-token-auth](gateway-bearer-token-auth.md) | Per-deployment bearer-token configuration ships in `/etc/endo-gateway/config.toml`; package installs a `config.toml.example` only. |
| [familiar-daemon-bundling](familiar-daemon-bundling.md) | Reference for the esbuild bundle shape the gateway packages consume; same `step:bundle` pattern. |
| [familiar-bundled-agents](familiar-bundled-agents.md) | Sibling bundling pattern; gateway packaging follows the same Node.js binary download approach. |
| [ci-no-npm-lifecycle](ci-no-npm-lifecycle.md) | The packaging workflow inherits the `YARN_ENABLE_SCRIPTS=false` posture; lifecycle scripts run in no packaging job. |
| [daemon-docker-selfhost](daemon-docker-selfhost.md) | Prior Docker design for the daemon (port 8920, `ENDO_ADDR`). [`gateway-package`](gateway-package.md) § Feature 10 makes this design's image (gateway as PID 1, `ENDO_HTTP_ADDR`, same port 8920) the target that story is revised onto, with user daemons in sidecar containers sharing the bootstrap socket volume. |
| [gateway-aws-deployment](gateway-aws-deployment.md) | **Stacked sibling.** Consumes this design's signed artifacts and deploys them to AWS. The artifact contract (what filenames, what signatures, what registry URLs) defines the interface between the two designs. |
| [gateway-aws-attuned](gateway-aws-attuned.md) | **Stacked grandchild.** The AWS-attuned variant of the gateway whose state backend (S3 + DynamoDB) replaces the local sqlite this design's packages install. |

## Phased Implementation

**Phase A**: deb + Docker only. The two most common shapes for first
adopters. CI workflow lands with the `package-deb` / `publish-apt` and
`package-docker` / `publish-docker` jobs; rpm, arch deferred.
Hosting bootstraps on GitHub Pages (`endojs.github.io/apt-repo/`) and
ghcr.io.

**Phase B**: `package-rpm` / `publish-rpm` jobs added. yum repo
bootstraps on GitHub Pages alongside apt.

**Phase C**: PKGBUILD added; AUR push step added. Arch users
serve themselves.

**Phase D**: hosting moves from GitHub Pages to S3 + CloudFront
(provisioned by [`gateway-aws-deployment`](gateway-aws-deployment.md)).
The `apt.endojs.org` and `rpm.endojs.org` CNAMEs flip; old GitHub
Pages URLs serve `301 Moved Permanently` for one release cycle.

Phases A through C run inside the parent design's Phase 4; the
packaging-CI work is the last work before the gateway ships to OS
package consumers.
Phase D depends on
[`gateway-aws-deployment`](gateway-aws-deployment.md) landing first.

## Design Decisions

1. **Independent build per distribution, common bundle source.**
   The deb / rpm / arch / docker jobs each build from the same
   esbuild output, in parallel, with no inter-dependency.
   Publication is split the same way (`publish-apt`, `publish-rpm`,
   `publish-aur`, `publish-docker`, each needing only its own package
   job), so a failure in one target does not block the others; a
   tag push with a failed target is an explicit partial release (see
   § Partial-release semantics).

2. **Tag-triggered, with a manual-dispatch staging path.**
   `gateway-v<semver>` tags fire the full pipeline; manual dispatch
   stages a draft GitHub Release without publishing to repos.
   This matches the existing `familiar-release.yml` pattern and lets
   the maintainer smoke-test a build before publishing.

3. **Per-repository signing keys, not the maintainer's personal key.**
   The apt and yum repos sign with dedicated keys stored in GitHub
   Secrets.
   Compromising a CI runner compromises a repository, not the
   maintainer's commit identity.

4. **Sigstore keyless signing for Docker images.**
   No long-lived Docker signing key to manage; the OIDC chain plus
   Rekor transparency log is the signature.
   Consumers verify with `cosign verify --certificate-identity-regexp`.

5. **OS package version exactly matches `@endo/gateway` npm version.**
   No drift, no per-distribution version games.
   One tag, one version, four artifacts.

6. **Linux-first; no Windows or macOS packages from this CI.**
   The parent's launchd and Windows Service shapes
   ([`gateway-package`](gateway-package.md) § Cross-platform service
   shape) are installed by `endo gateway start` or the Familiar
   installer, not by an artifact this workflow builds; desktop users
   run the Familiar-bundled variant.
   This decision can be revisited once a packaged system service on
   either platform has demand.

7. **Sqlite as the local state backend for the first cut.**
   The `node:sqlite` binding ships inside the pinned Node.js binary
   (no extra package dependency and no native addon to bundle),
   `PRAGMA user_version` covers migration metadata, and the
   AWS-attuned variant
   ([`gateway-aws-attuned`](gateway-aws-attuned.md)) replaces it
   transparently to the packaging layer.

## Open Questions

1. **Keyring distribution for first contact.**
   How does a Debian user trust the apt repository's signing key
   the first time?
   The `signed-by` directive plus a downloaded keyring file is the
   likely answer; named under § Signing Model.

2. **Long-term storage of repository signing keys.**
   GitHub Secrets is the bootstrap.
   AWS Secrets Manager (per
   [`gateway-aws-deployment`](gateway-aws-deployment.md)) is the
   likely long-term home, with CI pulling the key at job start.
   Pinning the migration to Secrets Manager waits for the AWS
   deployment landing.

3. **Graceful restart via systemd socket activation.**
   The first cut restarts hard.
   A socket-activation hand-off lets the new process pick up the
   listening socket while the old process drains in-flight
   requests; deferred to a follow-up.

4. **Per-distribution post-install systemd defaults.**
   Should the package enable the service by default (start on next
   boot) or leave the operator to enable explicitly?
   The `.deb` post-install enables but does not start; the `.rpm`
   `%systemd_post` macro is the same convention.
   Arch and Docker do not enable automatically (Arch follows the
   "operator decides everything" convention; Docker has no systemd
   in the container).
   Surfaced because it diverges per distribution; the answer is
   "match distribution convention" but the design could pin a
   uniform answer if the maintainer prefers.

5. **Release cadence frequency.**
   On-demand for the first cut; monthly once the gateway lands in
   production.
   Pinning the cadence here is premature; revisit after the first
   six releases.

6. **`nightly` channel security implications.**
   Nightly builds are unsigned-by-maintainer (CI signs with the
   repo key, same as stable).
   Consumers of `nightly` accept the trade-off explicitly; the docs
   warn loudly.
   Is that warning sufficient or should `nightly` use a *different*
   repository key so a nightly-channel compromise does not cascade
   into stable?
   Surfaced rather than picked.

## Prompt

> Please dispatch a designer to describe the next steps from
> implementing the Endo Gateway as pertaining to packaging for RPM,
> DEB &c, ideally using CI workflows. Then, stack a design on top of
> that describing automation for deploying Gateways to AWS. Consider
> also designing a Gateway attuned to AWS S3, EC2, Nitro Enclaves,
> Route53, and the appropriate analogue to sqlite for a hosted gateway
> service with a domain name.

(The full directive named three designs; this is the first.
See [`gateway-aws-deployment`](gateway-aws-deployment.md) for the
second and [`gateway-aws-attuned`](gateway-aws-attuned.md) for the
third.)
