# `@endo/space-nixos-admin`

`@endo/space-nixos-admin` is a local NixOS host-administration capability.
Despite the historical `space-` package name, its primary abstraction is the
`NixosAdmin` capability: it inspects the machine, edits a flake checkout, and
asks a separate root-owned service to build, activate, or roll back the system.

The Endo daemon remains unprivileged.
Applying a configuration is nevertheless root-equivalent because NixOS
activation can install services and run activation scripts.
Only trusted administrators should receive this capability.

## Host status

`getSystemInfo()` reports the local hostname, flake output name, NixOS release,
kernel and CPU, current system closure, configuration revision, and generation.
`getVitals()` reports a timestamped snapshot of systemd state, uptime, load
averages, memory, swap, and capacity for `/` and `/nix`.
`status()` combines both snapshots with the rebuild service's current status.
These reads work even when the rebuild service has not been configured, which
makes the capability useful for orientation and diagnosis before provisioning.

Byte quantities are `bigint` values.
Unavailable host fields are `null`; for example, memory is `null` when the
kernel and Node runtime both deny system-information queries.

## Configuration

Provision the controller with `setup.js` in `ENDO_EXTRA`, or instantiate
`caplet.js` as an unconfined formula with these environment variables:

- `ENDO_NIXOS_CONFIG_DIR`: writable checkout containing the NixOS flake.
- `ENDO_NIXOS_DIR`: spool shared with the privileged rebuild service.
- `ENDO_NIXOS_HOST`: optional `nixosConfigurations` output name.
  It defaults to the machine hostname, which is the usual NixOS convention.
- `ENDO_NIXOS_STATE_DIR`: optional parent state directory used by prebuilds.
- `ENDO_NIXOS_LOCK_DIR`: protected lock directory shared with the privileged
  service; defaults to `/run/lock/endo-nixos-admin`.

The rebuild service owns the privileged half of the
[versioned spool protocol](./PROTOCOL.md).
Mutating methods fail until both required directories are configured.

`setup-forgejo-credential.js` is an optional hosted-development integration.
It is not required to inspect or administer a NixOS machine.

## Administration flow

Use `listFiles`, `readFile`, `writeFile`, `stageFiles`, and `revertFiles` to
prepare a change.
Run `build()` before activation.
After explicit operator approval, `apply(message)` commits and activates it.
`rollback()` reactivates the last generation that passed the companion
service's health check.

`build`, `apply`, and `rollback` accept idempotency keys and wait for their own
terminal outcome.
Reusing a key returns its recorded outcome rather than issuing the privileged
operation again.
