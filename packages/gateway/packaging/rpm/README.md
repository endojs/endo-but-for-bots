# RPM packaging for endo-gateway

This directory holds the RPM spec file for the Endo Gateway.
The spec targets Fedora, RHEL / CentOS Stream / Rocky / AlmaLinux,
and openSUSE.
The macro names are portable across the three.

## Layout

```
packages/gateway/packaging/rpm/
  endo-gateway.spec   The spec.
  README.md           This file.
```

## Build

From a Fedora / RHEL host with `rpmdevtools` installed:

```sh
# 1. Stage the source tarball.
rpmdev-setuptree
tar -czf ~/rpmbuild/SOURCES/endo-gateway-0.1.0.tar.gz \
    --transform 's,^,endo-gateway-0.1.0/,' \
    packages/gateway designs/gateway-package.md

# 2. Build.
rpmbuild -ba packages/gateway/packaging/rpm/endo-gateway.spec
```

The resulting RPM lands under `~/rpmbuild/RPMS/noarch/`.

For a containerized build:

```sh
podman run --rm -v "$PWD":/src:Z -w /src fedora:40 \
    sh -c "dnf install -y rpm-build rpmdevtools nodejs && \
           rpmdev-setuptree && \
           tar -czf ~/rpmbuild/SOURCES/endo-gateway-0.1.0.tar.gz \
               --transform 's,^,endo-gateway-0.1.0/,' \
               packages/gateway designs/gateway-package.md && \
           rpmbuild -ba packages/gateway/packaging/rpm/endo-gateway.spec"
```

## Install

```sh
sudo dnf install ./endo-gateway-0.1.0-1.fc40.noarch.rpm
sudo systemctl enable --now endo-gateway
```

## Service account

The spec's `%pre` scriptlet creates the `endo:endo` system user
and group on first install via `groupadd --system` /
`useradd --system`.
Neither is removed on uninstall.
An operator that wants to remove them runs `userdel endo` /
`groupdel endo` after `dnf remove endo-gateway`.

## SELinux

The spec does **not** ship an SELinux policy module.
On a SELinux-enforcing host the gateway runs under the default
`init_t` to `unconfined_service_t` transition.
The managed directories under `/var/lib/endo-gateway/` need to be
labeled `var_lib_t` (the default for `/var/lib/*`).
The unit's `ProtectSystem=strict` interacts with the policy's
filesystem restrictions.
A downstream packager that needs tighter confinement adds an
`endo-gateway-selinux` subpackage with a `.te` / `.fc` / `.if`
triad.

## Cross-references

- The systemd unit body lives at
  `packages/gateway/systemd/endo-gateway.service`; this spec
  installs that exact file.
- The runtime documentation (path layout, security considerations,
  log tailing) lives at `packages/gateway/docs/system-service.md`.
- The cross-platform upgrade workflow lives at
  `packages/gateway/docs/packaging.md`.
