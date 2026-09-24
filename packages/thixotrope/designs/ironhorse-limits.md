# Configurable Ironhorse limits

This implements the daemon configuration work tracked in #1314.
The separate parser issue #1313 is fixed by upstream commit `242b339b8`, included in `llm`.

Thixotrope exposes one set of daemon-wide defaults through environment settings,
and reports the effective settings through `thix status`.
Per-vat overrides are a follow-up: the configuration is a single limits record,
passed at worker creation and reapplied after heap restoration.
Selecting a record per vat can later happen at that boundary.

The settings are the guest crank budget, trusted bootstrap budget, slot ceiling,
chunk ceiling, and process request timeout.
Computron budgets use exact decimal strings on JSON wires and u64 values in the worker.
The JavaScript engine API accepts decimal strings or bigint for wide budgets;
number inputs are supported within the unsigned 32-bit range.
Arena ceilings follow Ironhorse's u32 address spaces.
Timeouts follow Node's positive signed-32-bit millisecond timer range.
Zero and an unlimited mode are not supported.

The bootstrap budget covers both bootstrap scripts and trusted peer initialization.
The crank meter is rearmed for each evaluation, as before.
Heap ceilings limit the arenas across the vat's lifetime; completed cranks collect garbage.
The watchdog is independent of deterministic execution and heap limits.

## Restart policy

The user selected monotonic increases for existing workspaces.
Manifest version 2 separates immutable runtime identity (worker and bootstrap digests,
delivery protocol) from mutable execution limits.
Heap signatures depend on the immutable identity, so raising a ceiling preserves heap identity.
Under the existing exclusive store lease, startup rejects any execution-limit decrease
before preparing worker incarnations.
Accepted increases are written atomically and synced before any worker runs.
The timeout can change in either direction and is not part of the persisted execution profile.
Omitting a previously raised setting selects the default, which is rejected if it would decrease
the persisted limit; repeat the effective configuration on subsequent starts.

Raising limits does not clear existing worker failure metadata or automatically retry a failed vat.
That recovery workflow remains separate.
Version-1 manifests and old worker binaries still require an explicit migration or a fresh directory;
this change does not rewrite existing heap signatures from the earlier runtime format.
Once a workspace uses this version, increasing its execution defaults requires no state migration.

## Implementation and validation plan

Add exact configuration parsing, pass the limits through the supervisor and engine to the worker,
separate runtime identity from mutable limits, and expose effective settings in status.
Validate wide numeric values, each independently decreasing setting, preserved workspace state
after increases, heap restoration above the old default, and distinct meter/heap failures.
Run deterministic functional checks and the precommit subagent review loop before committing.

An initial large-array restoration fixture, `Array(1050000).fill(7)`, encountered Ironhorse's
`RangeError: property key space exhausted` before reaching the selected heap ceiling.
The restoration test uses a retained object chain above one million slots instead.
Property-key capacity is a separate engine limitation and is not configured by these settings.

Validation passed five worker Rust tests, two configuration tests in each SES mode,
and twelve native daemon tests covering limits, restart compatibility, recovery, and HTTP.
Package lint/typechecking, formatting, and package documentation also passed.
The final precommit subagent review found no actionable issues.
The root declaration build encountered generated-declaration conflicts in other packages;
root documentation also encountered unrelated package errors.
