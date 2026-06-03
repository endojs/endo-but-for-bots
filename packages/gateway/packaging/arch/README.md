# Arch packaging for endo-gateway

This directory holds the Arch `PKGBUILD` for the Endo Gateway.
The package follows Arch convention: a top-level `PKGBUILD` plus
an `endo-gateway.install` hook that does the post-install user
creation and the systemd-unit-path rewrite.

## Layout

```
packages/gateway/packaging/arch/
  PKGBUILD               The package recipe.
  endo-gateway.install   Post-install / upgrade / remove hooks.
  README.md              This file.
```

## Build

From a working Arch host with `base-devel` installed:

```sh
# 1. Stage the source tarball alongside PKGBUILD.
cp packages/gateway/packaging/arch/PKGBUILD .
cp packages/gateway/packaging/arch/endo-gateway.install .
tar -czf endo-gateway-0.1.0.tar.gz \
    --transform 's,^,endo-gateway-0.1.0/,' \
    packages/gateway designs/gateway-package.md

# 2. Build.
makepkg --syncdeps --noconfirm
```

The resulting package lands as
`endo-gateway-0.1.0-1-any.pkg.tar.zst`.

## Install

```sh
sudo pacman -U endo-gateway-0.1.0-1-any.pkg.tar.zst
sudo systemctl enable --now endo-gateway
```

## Convention drift from the systemd unit

The shipped systemd unit at
`packages/gateway/systemd/endo-gateway.service` references
`EnvironmentFile=-/etc/default/endo-gateway` (the Debian / Fedora
convention).
Arch's convention is `/etc/conf.d/<unit-name>`.
The `endo-gateway.install` script's `post_install` and
`post_upgrade` hooks rewrite the path in-place after `pacman`
lays down the unit, so an Arch user lands their overrides under
`/etc/conf.d/endo-gateway` and the unit reads from there.
The same operator overrides apply (see the comment block in the
operator file).

## Service account

`post_install` creates the `endo:endo` system user and group via
`groupadd --system` / `useradd --system`.
The user persists across `pacman -R endo-gateway`.
The `post_remove` hook prints the hand-cleanup recipe.

## Cross-references

- The systemd unit body lives at
  `packages/gateway/systemd/endo-gateway.service`; this `PKGBUILD`
  installs that exact file and patches it in `post_install`.
- The runtime documentation (path layout, security considerations,
  log tailing) lives at `packages/gateway/docs/system-service.md`.
- The cross-platform upgrade workflow lives at
  `packages/gateway/docs/packaging.md`.
