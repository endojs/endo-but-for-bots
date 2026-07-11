# Debian / Ubuntu packaging for endo-gateway

This directory holds the `.deb` build recipe for the Endo Gateway.
The shape follows the standard Debian source-package layout: a
`debian/` subdirectory with `control`, `changelog`, `rules`, the
maintainer scripts (`postinst`, `postrm`), and the install map.

## Layout

```
packages/gateway/packaging/debian/
  debian/
    changelog                Source-package changelog (one stanza per release).
    compat                   debhelper compat level (13).
    control                  Source / binary package metadata.
    copyright               Apache-2.0 declaration in the machine-readable format.
    endo-gateway.install     File-install manifest.
    endo-gateway.service     Pointer comment (see packages/gateway/systemd/).
    postinst                 adduser + directory creation on install.
    postrm                   service stop + (on purge) state cleanup.
    rules                    debhelper sequencer overrides.
    source/format            "3.0 (native)".
  endo-gateway.default       /etc/default/endo-gateway operator overrides.
  README.md                  This file.
```

## Build

The recipe assumes it is invoked from the upstream source tree's
root (the monorepo root), not from this `packaging/debian/`
subdirectory, because the `debhelper` sequencer expects `debian/`
to be at the source tree's top.

The straightforward build path is:

```sh
# 1. From the monorepo root, copy the debian/ subdirectory up.
cp -a packages/gateway/packaging/debian/debian .

# 2. Run a vendored install so the package payload is staged.
corepack yarn install --immutable

# 3. Build the .deb.
dpkg-buildpackage -us -uc -b
```

The resulting `endo-gateway_0.1.0-1_all.deb` lands in the parent
directory.

For a CI-friendly approach, downstream packagers should adopt a
top-level `debian/` symlink to this directory, or copy the recipe
into the source tarball at release-tarball-preparation time.

## Install

```sh
sudo apt install ./endo-gateway_0.1.0-1_all.deb
sudo systemctl status endo-gateway
```

The unit installs disabled.
To enable on boot and start now:

```sh
sudo systemctl enable --now endo-gateway
```

## Service account

The `postinst` creates the `endo:endo` system user and group on
first install.
The user is unprivileged, has shell `/usr/sbin/nologin`, and has
its home at `/var/lib/endo-gateway`.
The user is **not** deleted on package removal.
It is deleted on `apt purge`.

## Configuration

The unit reads `/etc/default/endo-gateway` as an `EnvironmentFile`.
The shipped default is a commented-out template.
Uncomment lines to override the bind address, the runtime / state
directories, or the trusted-proxy CIDR allowlist (Feature 9).

The richer TOML configuration file at
`/etc/endo-gateway/config.toml` is reserved for the post-merge
HTTP-listener wire-up.
Until then, the gateway uses only `ENDO_HTTP_ADDR` and the
per-directory overrides from `EnvironmentFile`.

## Cross-references

- The systemd unit body lives at
  `packages/gateway/systemd/endo-gateway.service`; this recipe
  installs that exact file.
- The runtime documentation (path layout, security considerations,
  log tailing) lives at `packages/gateway/docs/system-service.md`.
- The cross-platform upgrade workflow lives at
  `packages/gateway/docs/packaging.md`.
