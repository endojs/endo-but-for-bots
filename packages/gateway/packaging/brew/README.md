# Homebrew packaging for endo-gateway

This directory holds the Homebrew formula for the Endo Gateway.
The formula targets the developer-machine / personal-laptop
shape, not a per-host system service.
For the latter, follow the LaunchDaemon procedure in
`packages/gateway/docs/system-service.md`.

## Layout

```
packages/gateway/packaging/brew/
  endo-gateway.rb   The formula.
  README.md         This file.
```

## Install

From a macOS host with Homebrew installed:

```sh
# 1. Stage the formula in a custom tap (Homebrew core acceptance is
#    a separate workstream; in the interim, downstream users tap
#    the formula directly from this directory).
brew tap endojs/endo https://github.com/endojs/endo
brew install endo-gateway

# 2. Start the per-user LaunchAgent.
brew services start endo-gateway

# 3. Check the resolved paths.
endo gateway where
```

## LaunchAgent versus LaunchDaemon

The Homebrew formula installs a **LaunchAgent**: per-user, runs
under the calling user's account, started by
`brew services start`.
The plist at
`packages/gateway/systemd/com.endojs.endo-gateway.plist` is the
**LaunchDaemon** form: system-wide, runs under `_endo:_endo`,
managed by `launchctl bootstrap system`.

The two coexist with different responsibilities:

| Form        | Lifetime          | User      | Managed by        | Path                                |
|-------------|-------------------|-----------|-------------------|-------------------------------------|
| LaunchAgent | Per-login         | $USER     | `brew services`   | `~/Library/LaunchAgents/`           |
| LaunchDaemon| Per-boot          | `_endo`   | `launchctl`       | `/Library/LaunchDaemons/`           |

A developer machine that just wants the gateway available for
local Endo work uses the LaunchAgent.
A server machine that hosts the gateway for many users uses the
LaunchDaemon.

## sha256

The formula's `sha256 "SKIP"` is a placeholder.
The release workflow computes the real digest at tag time and
rewrites the formula on the tap branch.
`SKIP` is rejected by `brew audit --new-formula` so it is
impossible to publish a formula in this state by accident.

## Cross-references

- The LaunchDaemon plist lives at
  `packages/gateway/systemd/com.endojs.endo-gateway.plist`.
- The runtime documentation (path layout, security considerations,
  log tailing) lives at `packages/gateway/docs/system-service.md`.
- The cross-platform upgrade workflow lives at
  `packages/gateway/docs/packaging.md`.
