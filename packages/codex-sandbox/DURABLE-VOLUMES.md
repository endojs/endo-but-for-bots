# Retired Codex volume subsystem

Hosted-agent unification replaces the Podman volume registry, XFS quota host,
registry worker, and storage leases with shared session ownership and directories.
The old allocation and recovery APIs are no longer supported.

See [current setup](./HOSTED-SUBSCRIPTION.md) and
[deployment acceptance](./DEPLOYMENT-ACCEPTANCE.md).
Historical XFS evidence does not establish directory-storage enforcement.
The current persistent directories have no per-session kernel disk quota.

Old deployments require deliberate retirement of retained formulas and exact
native resources before provisioning new services.
Preserve Secrets; changing code alone does not remove old resources.
