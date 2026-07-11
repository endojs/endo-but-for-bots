# Endo Gateway distribution packaging

This document is the cross-platform upgrade-workflow reference for
the Endo Gateway's distribution packages.
The runtime guidance (path layout, security considerations, log
tailing, the CLI reference) lives at
[`system-service.md`](system-service.md).
The per-distribution build and install detail lives in each
recipe's `README.md` under [`../packaging/`](../packaging/).

The gateway ships five distribution recipes, each targeting a
different OS / package-manager pairing:

| Recipe      | Target                       | Service manager     | Recipe dir                            |
| ----------- | ---------------------------- | ------------------- | ------------------------------------- |
| `.deb`      | Debian, Ubuntu               | systemd             | [`../packaging/debian/`](../packaging/debian/)  |
| `.rpm`      | Fedora, RHEL, openSUSE       | systemd             | [`../packaging/rpm/`](../packaging/rpm/)        |
| `PKGBUILD`  | Arch                         | systemd             | [`../packaging/arch/`](../packaging/arch/)      |
| `Dockerfile`| Any OCI runtime              | Container runtime   | [`../packaging/docker/`](../packaging/docker/)  |
| Homebrew    | macOS (developer-machine)    | launchd (LaunchAgent) | [`../packaging/brew/`](../packaging/brew/)    |

For a per-host system service on macOS (not the developer-machine
LaunchAgent), follow the LaunchDaemon procedure in
[`system-service.md`](system-service.md) § macOS: launchd.
For Linux containers, the OCI runtime is the service manager
(Docker, Podman, Kubernetes).
See [`../packaging/docker/README.md`](../packaging/docker/README.md)
for the container shape.

## What each recipe installs

Every recipe lands the same artifacts at the same logical paths.
The per-distribution prefix differs.

| Artifact                              | Linux path                                | macOS Homebrew path                          |
| ------------------------------------- | ----------------------------------------- | -------------------------------------------- |
| systemd unit                          | `/lib/systemd/system/endo-gateway.service`| n/a (launchd LaunchAgent)                    |
| launchd plist (system-wide)           | n/a                                       | `/Library/LaunchDaemons/com.endojs.endo-gateway.plist` |
| Application payload                   | `/usr/lib/endo-gateway/gateway/`          | `$(brew --prefix)/opt/endo-gateway/libexec/` |
| `endo` CLI shim                       | `/usr/bin/endo`                           | `$(brew --prefix)/bin/endo`                  |
| Operator override file                | `/etc/default/endo-gateway` (.deb)        | n/a                                          |
|                                       | `/etc/sysconfig/endo-gateway` (.rpm)      |                                              |
|                                       | `/etc/conf.d/endo-gateway` (Arch)         |                                              |
| Config directory                      | `/etc/endo-gateway/`                      | `$(brew --prefix)/etc/endo-gateway/`         |
| Durable state                         | `/var/lib/endo-gateway/`                  | `$(brew --prefix)/var/lib/endo-gateway/`     |
| Log directory                         | `/var/log/endo-gateway/`                  | `$(brew --prefix)/var/log/endo-gateway/`     |
| Cache directory                       | `/var/cache/endo-gateway/`                | `$(brew --prefix)/var/cache/endo-gateway/`   |
| Runtime / sockets                     | `/run/endo-gateway/`                      | `$(brew --prefix)/var/run/endo-gateway/`     |
| Documentation                         | `/usr/share/doc/endo-gateway/`            | `$(brew --prefix)/share/doc/endo-gateway/`   |

The runtime documentation at
[`system-service.md`](system-service.md) § Path layout is the
canonical version of this table.

## Service account

Every Linux recipe creates the `endo:endo` system user / group on
first install.
The macOS LaunchDaemon plist references `_endo:_endo` (macOS
convention for system users).
The Homebrew LaunchAgent runs under the calling user's account.
No service account is created in that case.

| Recipe      | User / group       | Created by                          | Removed by                          |
| ----------- | ------------------ | ----------------------------------- | ----------------------------------- |
| `.deb`      | `endo:endo`        | `debian/postinst` (`adduser`)       | `debian/postrm purge` (`deluser`)   |
| `.rpm`      | `endo:endo`        | `%pre` (`useradd --system`)         | not removed (operator action)       |
| `PKGBUILD`  | `endo:endo`        | `endo-gateway.install` `post_install` (`useradd --system`) | not removed (operator action)       |
| `Dockerfile`| `endo:endo` (1001:1001) | `RUN useradd` in image build   | n/a (per-container)                 |
| Homebrew    | calling user       | n/a                                 | n/a                                 |

## Install

### Debian / Ubuntu

```sh
sudo apt install ./endo-gateway_0.1.0-1_all.deb
sudo systemctl enable --now endo-gateway
```

The `.deb` postinst creates the service user and the managed
directories, then leaves the unit disabled.
The `systemctl enable --now` line is the operator's explicit
start.

See [`../packaging/debian/README.md`](../packaging/debian/README.md)
for the build recipe.

### Fedora / RHEL / openSUSE

```sh
sudo dnf install ./endo-gateway-0.1.0-1.noarch.rpm
sudo systemctl enable --now endo-gateway
```

See [`../packaging/rpm/README.md`](../packaging/rpm/README.md) for
the build recipe.

### Arch

```sh
sudo pacman -U endo-gateway-0.1.0-1-any.pkg.tar.zst
sudo systemctl enable --now endo-gateway
```

The `PKGBUILD`'s `.install` hook rewrites the unit's
`EnvironmentFile` path from `/etc/default/endo-gateway` (Debian /
Fedora convention) to `/etc/conf.d/endo-gateway` (Arch
convention).

See [`../packaging/arch/README.md`](../packaging/arch/README.md)
for the build recipe.

### Docker / Podman

```sh
docker pull ghcr.io/endojs/endo-gateway:0.1.0   # when the image ships
# OR build locally from the monorepo root:
docker build -f packages/gateway/packaging/docker/Dockerfile -t endo-gateway:0.1.0 .

docker run -d \
    --name endo-gateway \
    --restart unless-stopped \
    -p 3469:3469 \
    -v endo-gateway-state:/var/lib/endo-gateway \
    endo-gateway:0.1.0
```

See [`../packaging/docker/README.md`](../packaging/docker/README.md)
for the build context and volume detail.

### Homebrew

```sh
brew tap endojs/endo https://github.com/endojs/endo
brew install endo-gateway
brew services start endo-gateway
```

See [`../packaging/brew/README.md`](../packaging/brew/README.md)
for the LaunchAgent vs LaunchDaemon distinction.

## Upgrade

The upgrade workflow is the package manager's standard upgrade
verb.
The maintainer scripts (`postinst` for `.deb`, `%post` for
`.rpm`, `post_upgrade` for Arch) re-apply the directory setup
but do **not** restart the service.
The operator restarts explicitly:

| Recipe      | Upgrade                                              | Restart                                              |
| ----------- | ---------------------------------------------------- | ---------------------------------------------------- |
| `.deb`      | `sudo apt install --only-upgrade endo-gateway`       | `sudo systemctl restart endo-gateway`                |
| `.rpm`      | `sudo dnf upgrade endo-gateway`                      | `sudo systemctl restart endo-gateway` (`%postun_with_restart` macro restarts if it was running) |
| `PKGBUILD`  | `sudo pacman -Syu` (or `-U` of the new package file) | `sudo systemctl restart endo-gateway`                |
| `Dockerfile`| `docker pull` + `docker stop` + `docker run`         | implicit in the new `docker run`                     |
| Homebrew    | `brew upgrade endo-gateway`                          | `brew services restart endo-gateway`                 |

For zero-downtime upgrades, run two gateway instances behind a
reverse proxy and rotate them.
The gateway's persistent state under `/var/lib/endo-gateway/` is
the only thing that must not be written to concurrently.
A rolling upgrade pattern that takes one instance down before the
other comes up is the safe shape.

## Uninstall

The uninstall workflow is the package manager's standard remove
verb.
State directories survive a plain remove on Debian and Arch (and
on RPM).
They are removed on a `apt purge`.
Operators that want a clean uninstall under RPM or Arch remove
the directories by hand.

| Recipe      | Remove (keep state)                  | Purge (delete state)                              |
| ----------- | ------------------------------------ | ------------------------------------------------- |
| `.deb`      | `sudo apt remove endo-gateway`       | `sudo apt purge endo-gateway`                     |
| `.rpm`      | `sudo dnf remove endo-gateway`       | `sudo dnf remove endo-gateway && sudo rm -rf /var/lib/endo-gateway /var/log/endo-gateway /var/cache/endo-gateway /etc/endo-gateway && sudo userdel endo && sudo groupdel endo` |
| `PKGBUILD`  | `sudo pacman -R endo-gateway`        | `sudo pacman -Rns endo-gateway && sudo rm -rf /var/lib/endo-gateway /var/log/endo-gateway /var/cache/endo-gateway /etc/endo-gateway && sudo userdel endo && sudo groupdel endo` |
| `Dockerfile`| `docker rm -f endo-gateway`          | `docker volume rm endo-gateway-state endo-gateway-log` |
| Homebrew    | `brew uninstall endo-gateway`        | `brew uninstall endo-gateway && rm -rf $(brew --prefix)/var/{lib,log,cache,run}/endo-gateway $(brew --prefix)/etc/endo-gateway` |

## Configuration

The gateway reads configuration in three layers (later wins):

- Built-in defaults in `packages/gateway/src/config.js`.
- The TOML config file at the path named in
  `ENDO_GATEWAY_CONFIG_FILE` (or the per-platform default in
  [`system-service.md`](system-service.md) § Path layout).
- Environment variables.
  The systemd unit's `EnvironmentFile=` directive reads from
  `/etc/default/endo-gateway` (Debian / Fedora) or
  `/etc/conf.d/endo-gateway` (Arch).
  The LaunchAgent reads `environment_variables` from the
  formula's service block.
  The container reads `ENV` lines from the Dockerfile.

The shipped environment-override file (under
[`../packaging/debian/endo-gateway.default`](../packaging/debian/endo-gateway.default))
is the canonical template.
The RPM and Arch recipes install the same file at their
respective paths.

## Trusted proxy CIDRs

Feature 9 (HTTPS terminating proxy compatibility) is configured
via the `ENDO_GATEWAY_TRUSTED_PROXY_CIDRS` environment variable.
The variable is empty by default (fail-closed).
A deployment behind a reverse proxy sets it to the proxy's
source CIDR allowlist.
See the Feature 9 design and [`https-proxy.md`](https-proxy.md)
for the trust model.

## CI integration

The recipes are checked into version control but not yet wired
into CI.
A follow-on PR adds workflows that:

- Build the `.deb` against the Debian stable and Ubuntu LTS
  images on every release tag.
- Build the `.rpm` against Fedora and a RHEL-equivalent base on
  every release tag.
- Build the `Dockerfile` and push to GHCR
  (`ghcr.io/endojs/endo-gateway`) on every release tag.
- Open the Homebrew formula's tap-side PR with the correct
  `sha256` digest on every release tag.

The Arch `PKGBUILD` is the only recipe that does not need a CI
job in the upstream repo.
Downstream AUR maintainers pull the recipe from this directory
when they update the AUR entry.

## Out of scope

- **HTTP listener wire-up.**
  The gateway's HTTP / WebSocket server is wired up by a sibling
  PR (the Phase 11a builder dispatch).
  The recipes here install the unit and payload, but
  `endo gateway run` cannot serve traffic until that PR lands.
- **Windows packaging.**
  The design's Feature 10 names rpm / deb / PKGBUILD / Docker.
  Windows packaging (MSI, Chocolatey, Scoop) is a separate
  decision tracked in the Familiar app packaging impact section
  of the design.
- **SELinux / AppArmor profiles.**
  Distro-specific MAC profile modules are downstream packager
  work.
  See [`../packaging/rpm/README.md`](../packaging/rpm/README.md)
  § SELinux for the shape of the missing piece.

## Cross-references

- [`system-service.md`](system-service.md): runtime guidance
  (path layout, security considerations, log tailing, CLI
  reference).
- [`https-proxy.md`](https-proxy.md): Feature 9 trust model and
  reverse-proxy examples.
- `../README.md`: package-level overview.
- `../../../designs/gateway-package.md` § Feature 10: design
  discussion.
