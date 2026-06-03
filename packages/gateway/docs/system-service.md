# Endo Gateway as a system service

This document covers running the Endo Gateway as a per-host system
service.
The gateway also runs in **user mode** as a per-user developer process
(the default when launched from a normal account without
`INVOCATION_ID` set); user-mode paths follow XDG and Apple
conventions, not the system-service paths below.

See `designs/gateway-package.md` § Feature 10 for the design
discussion and `packages/gateway/README.md` for the package-level
README.

## What "system service" means here

A system-service deployment of the Endo Gateway:

- Runs as a dedicated, unprivileged service account (`endo:endo` on
  Linux, `_endo:_endo` on macOS).
- Stores durable state under the OS's standard system-wide locations
  (`/var/lib/...` on Linux, `/usr/local/var/lib/...` on macOS).
- Is supervised by the platform's idiomatic service manager (systemd
  on Linux, launchd on macOS).
- Reads its configuration from a system-wide path
  (`/etc/endo-gateway/config.toml` on Linux,
  `/usr/local/etc/endo-gateway/config.toml` on macOS).

The gateway never requires root at runtime, even in system mode.
The service account `endo` is unprivileged; the only root-level steps
are the one-time install (creating the account, the directories, and
the unit file).

## Service-mode detection

The gateway selects between system and user mode by consulting three
signals, any one of which is sufficient to pick system mode:

1. Effective UID 0 (`process.geteuid()` returns `0`).
2. `INVOCATION_ID` set in the environment (systemd sets this for every
   unit it starts; the value is the systemd-assigned 128-bit ID).
3. The `--system` flag passed to `endo gateway start` / `endo gateway
   run` / `endo gateway stop`.

The CLI prints the detected mode at the top of `endo gateway where`;
the test of any deployment is to compare that output against
expectations.

## Path layout

| Concern        | System (Linux)                       | System (macOS)                                       | User (XDG)                                                 |
| -------------- | ------------------------------------ | ---------------------------------------------------- | ---------------------------------------------------------- |
| Durable state  | `/var/lib/endo-gateway/`             | `/usr/local/var/lib/endo-gateway/`                   | `$XDG_STATE_HOME/endo-gateway/` or `~/.local/state/endo-gateway/` |
| Runtime / pid  | `/run/endo-gateway/`                 | `/usr/local/var/run/endo-gateway/`                   | `$XDG_RUNTIME_DIR/endo-gateway/` or `~/.local/run/endo-gateway/`  |
| Logs           | `/var/log/endo-gateway/`             | `/usr/local/var/log/endo-gateway/`                   | `$XDG_STATE_HOME/endo-gateway/log/`                        |
| Cache          | `/var/cache/endo-gateway/`           | `/usr/local/var/cache/endo-gateway/`                 | `$XDG_CACHE_HOME/endo-gateway/`                            |
| Config file    | `/etc/endo-gateway/config.toml`      | `/usr/local/etc/endo-gateway/config.toml`            | `$XDG_CONFIG_HOME/endo-gateway/config.toml`                |

Every path is overridable via a per-directory environment variable
(`ENDO_GATEWAY_STATE_DIR`, `ENDO_GATEWAY_RUNTIME_DIR`,
`ENDO_GATEWAY_LOG_DIR`, `ENDO_GATEWAY_CACHE_DIR`,
`ENDO_GATEWAY_CONFIG_FILE`).
The override is taken verbatim; an operator that wants to host the
gateway under `/srv/endo` sets each variable individually.

## Linux: systemd

A starter unit ships at `packages/gateway/systemd/endo-gateway.service`.
The same content is also producible at install time via
`endo gateway install-systemd`.

### One-time install

```sh
# 1. Create the service account. --system marks it as a system
#    account (UID < 1000), --shell /usr/sbin/nologin prevents
#    interactive logins, and --home points at the gateway's state
#    directory. The gateway's `start` writes nothing under the
#    home, but pointing it there is the standard shape for a
#    daemon's service user.
sudo useradd --system \
    --home /var/lib/endo-gateway \
    --shell /usr/sbin/nologin \
    endo

# 2. Create the directories systemd would auto-create on first start.
#    Pre-creating them lets the operator land the config file before
#    the first start.
sudo install -d -o endo -g endo -m 0750 \
    /var/lib/endo-gateway \
    /var/log/endo-gateway \
    /var/cache/endo-gateway
sudo install -d -m 0755 /etc/endo-gateway

# 3. Install the unit. Use the shipped file or generate it:
sudo cp packages/gateway/systemd/endo-gateway.service /etc/systemd/system/
# OR:
sudo endo gateway install-systemd --output /etc/systemd/system/endo-gateway.service

# 4. (Optional) Land an environment file with operator-specific
#    overrides (alternate bind address, feature toggles).
sudo install -m 0640 -o root -g endo /dev/stdin /etc/default/endo-gateway <<'EOF'
# ENDO_HTTP_ADDR=127.0.0.1:3469
# ENDO_GATEWAY_FEATURE_GIT_HTTP=true
EOF

# 5. Reload systemd and enable the unit.
sudo systemctl daemon-reload
sudo systemctl enable --now endo-gateway

# 6. Verify.
sudo systemctl status endo-gateway
journalctl -u endo-gateway -f
```

### Logs

The unit's `LogsDirectory=endo-gateway` directive creates
`/var/log/endo-gateway/` for the gateway's own log file, and
systemd's journal captures stdout/stderr by default.
For interactive tailing:

```sh
journalctl -u endo-gateway -f          # journal-captured stderr
sudo tail -f /var/log/endo-gateway/gateway.log   # if the unit appends here
sudo endo gateway log -f --system      # CLI wrapper for the above
```

### Hardening

The shipped unit landed the following systemd hardening directives:

| Directive                       | Effect                                                    |
| ------------------------------- | --------------------------------------------------------- |
| `ProtectSystem=strict`          | `/usr`, `/boot`, `/efi` read-only.                        |
| `ProtectHome=true`              | `/home`, `/root`, `/run/user` inaccessible.               |
| `NoNewPrivileges=true`          | No `setuid`/`setgid` escalation.                          |
| `PrivateTmp=true`               | Private `/tmp` and `/var/tmp`.                            |
| `ProtectKernelTunables=true`    | `/proc/sys`, `/sys` read-only.                            |
| `ProtectKernelModules=true`     | No module load/unload.                                    |
| `ProtectControlGroups=true`     | cgroup hierarchy read-only.                               |
| `RestrictNamespaces=true`       | No namespace operations.                                  |
| `RestrictRealtime=true`         | No real-time scheduling.                                  |
| `LockPersonality=true`          | `personality(2)` locked.                                  |
| `MemoryDenyWriteExecute=true`   | No `mprotect(PROT_EXEC | PROT_WRITE)`.                    |
| `SystemCallArchitectures=native`| Only native syscall ABI.                                  |

The set is the systemd-recommended baseline for a network daemon that
needs no exotic kernel privileges.
A deployment that adds further restrictions (`SystemCallFilter`,
`CapabilityBoundingSet=`, an AppArmor or SELinux profile) edits the
unit; nothing in the design needs the gateway's own code to know
about them.

### Container deployments

Inside a Docker / Podman container, the **container runtime** is the
service manager (per the design's "Cross-platform service shape").
The container image runs `endo gateway run --system` as PID 1; the
container restart policy (`unless-stopped`, `always`) takes the place
of systemd's `Restart=on-failure`.
The container's working directory should be `/var/lib/endo-gateway/`
and the runtime / state / log / cache directories should be mounted
or `tmpfs`-backed as appropriate.

The packaging-side dockerfile lives in
`packages/gateway/systemd/` (alongside the systemd unit and the
launchd plist) once the `.deb` / `.rpm` / `Dockerfile` skeletons land
per the design's Feature 10.

## macOS: launchd

A starter LaunchDaemon plist ships at
`packages/gateway/systemd/com.endojs.endo-gateway.plist`.

### One-time install

```sh
# 1. Create the service user (system user, no login). macOS uses
#    underscore-prefixed system user names by convention.
sudo dscl . -create /Users/_endo
sudo dscl . -create /Users/_endo UserShell /usr/bin/false
sudo dscl . -create /Users/_endo UniqueID 250
sudo dscl . -create /Users/_endo PrimaryGroupID 250
sudo dscl . -create /Users/_endo NFSHomeDirectory /usr/local/var/lib/endo-gateway
sudo dscl . -create /Groups/_endo PrimaryGroupID 250

# 2. Create the directories.
sudo install -d -o _endo -g _endo -m 0750 \
    /usr/local/var/lib/endo-gateway \
    /usr/local/var/run/endo-gateway \
    /usr/local/var/log/endo-gateway \
    /usr/local/var/cache/endo-gateway

# 3. Install the plist.
sudo cp packages/gateway/systemd/com.endojs.endo-gateway.plist \
    /Library/LaunchDaemons/

# 4. Load.
sudo launchctl load -w /Library/LaunchDaemons/com.endojs.endo-gateway.plist
```

### Logs (macOS)

```sh
tail -f /usr/local/var/log/endo-gateway/gateway.log
endo gateway log -f --system
```

## Security considerations

- **Never run the gateway as root.** The service account exists so the
  process can drop privileges (or never have them in the first place,
  which is the systemd default with `User=endo`).
  The unit file's `User=endo` directive sets the runtime UID; the
  one-time install creates the user.
- **The gateway has no built-in TLS.** Operators that want HTTPS run
  the gateway behind a TLS-terminating reverse proxy and turn on the
  `proxy.trustedCidrs` allowlist in the config so the gateway honors
  `X-Forwarded-*` only from that proxy.
  See `designs/gateway-package.md` § Feature 9 for the trust model.
- **The admin sock is sensitive.** The `GatewayAdmin` exo
  (Feature 7) is reachable over `admin.sock`, never on the network.
  The packaged systemd unit places `admin.sock` under
  `/run/endo-gateway/` with mode `0700` on the parent directory in
  packaged variants; only the administrator's OS account should be
  able to `connect(2)` to it.
  A custom packaging that puts the admin sock on a world-readable
  path is a security regression; the design names this explicitly.
- **The bootstrap sock is local-only.** Any local process that can
  `connect(2)` to `bootstrap.sock` can register a relay or weblet.
  The packaged mode is `0660` and `endo:endo`; widen at deployment
  discretion.

## CLI reference

The `endo gateway` subcommand group:

```
endo gateway start [--system]      # background-fork the daemon
endo gateway run [--system]        # foreground (for systemd Type=simple)
endo gateway stop [--system]       # send SIGTERM, wait, unlink pid
endo gateway log [-f] [--system]   # tail gateway.log
endo gateway where [-j] [--system] # print resolved paths
endo gateway install-systemd [-o PATH] [--exec-start CMD]
                                   # render the systemd unit
```

Every verb auto-detects the service mode unless `--system` is passed
explicitly; the auto-detection consults `geteuid() == 0`,
`INVOCATION_ID`, and the explicit flag (any one suffices).
