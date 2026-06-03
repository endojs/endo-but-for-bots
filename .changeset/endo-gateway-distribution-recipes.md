---
'@endo/gateway': minor
---

`@endo/gateway` Feature 10 (distribution recipes): adds `.deb`,
`.rpm`, Arch `PKGBUILD`, `Dockerfile`, and Homebrew formula
templates under `packages/gateway/packaging/`, plus a cross-platform
upgrade-workflow reference at `packages/gateway/docs/packaging.md`.

Every Linux recipe installs the systemd unit shipped at
`packages/gateway/systemd/endo-gateway.service` and creates the
`endo:endo` system service account on first install. The Docker
image is the gateway's PID 1 (the container runtime takes the
place of systemd). The Homebrew formula installs a per-user
LaunchAgent; the system-wide LaunchDaemon plist (also shipped at
`packages/gateway/systemd/com.endojs.endo-gateway.plist`) is the
separate per-host shape documented in
`packages/gateway/docs/system-service.md`.

Scope-bounded: the recipes install the unit + payload, but the
gateway's HTTP / WebSocket listener wire-up lands in a sibling PR
(Feature 8 / Feature 4 follow-on). Until that lands, the daemon
that links the gateway uses its own listener and feeds the
gateway's handlers as today.
