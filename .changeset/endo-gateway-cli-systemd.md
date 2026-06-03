---
'@endo/cli': minor
'@endo/gateway': minor
---

Add `endo gateway` CLI subcommand group (`start`, `run`, `stop`, `log`,
`where`, `install-systemd`) for managing the Endo Gateway daemon, plus
the system-service path resolver in `@endo/gateway`
(`detectServiceMode`, `resolveGatewayPaths`). The resolver picks
between system mode (Linux: `/var/lib`, `/run`, `/var/log`,
`/var/cache`, `/etc`; macOS: `/usr/local/var/...`) and user mode (XDG
or Apple-convention paths) by inspecting `geteuid()`, the
`INVOCATION_ID` env var (set by systemd), and an explicit `--system`
flag. Per-directory `ENDO_GATEWAY_*_DIR` env vars override each path
individually. A starter systemd unit ships at
`packages/gateway/systemd/endo-gateway.service` and a launchd plist
ships at `packages/gateway/systemd/com.endojs.endo-gateway.plist`;
both are rebuildable from `endo gateway install-systemd`. See
`packages/gateway/docs/system-service.md` for the install procedure
on Linux and macOS (#343 follow-up).
