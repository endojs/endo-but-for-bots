# W2 allocation and regexp admission

Implemented on `codex/w2-allocation-chokepoint`, based on `bots/llm` at
`a4f74814f`.
This follow-up covers W2.3–W2.6: the allocation half of F073, F021, the arena
ceiling and `HeapExhausted` portion of F010/F076, and regexp work admission in
F074/F132.
The dated findings in the original review remain a historical record.

## Admission contract

`Meter::charge_and_check(raw, host)` adds a checked raw charge and checks the
armed meter before work proceeds, consulting the host when its reporting
interval is crossed.
Overflow fails closed, including when the meter is unarmed.
Refused work retains its admitted charge.
The interpreter propagates a refusal as `Halt::MeterAbort`, outside guest
`try`/`catch`.

`Interp::reserve_units` admits string output against its format limit and the
configured chunk headroom, charges the modeled chunk cost, checks the host,
and then permits a fallible reservation.
Incremental output uses the same calculation through `reserve_units_growth`;
charging the difference avoids charging each accumulated prefix again.
Element and representation scratch use byte-sized `reserve_scratch`,
`reserve_work_scratch`, and bounded growth helpers.
Checked arithmetic precedes capacity construction.

The routed paths include repeat, padding, join, String.raw, concat, replacement,
Unicode case conversion and normalization, JSON serialization and parsing,
flat, ArrayBuffer allocation and transfer, dense array copies, sorting,
argument forwarding, iterable collection, own-key collection, and BigInt radix
rendering.
Generic array loops check admitted work between guest operations.
JSON parsing bounds element storage even without reviver metadata and decodes
one UTF-8 scalar at a time, avoiding repeated validation of the remaining input.
Proxy own-key forwarding stays outside the larger materialization frame, so the
existing native-stack contract is preserved.

## Heap policy

The defaults are **1,000,000 slot addresses** and **256 MiB of chunk bytes**.
Hosts configure them through `vm.slots.set_ceiling(...)` and
`vm.chunks.set_ceiling(...)`.
Slot free-list reuse remains possible at the ceiling; growing the address space
is refused before mutation.
Chunk admission includes the four-byte payload-length header and retains the
exclusive `u32` addressability bound.

Arena reservation failure and ceiling exhaustion use a private unwind marker
that only the interpreter's run boundary translates to `Halt::HeapExhausted`.
This halt cannot be caught by guest JavaScript and leaves the crank incomplete.
Unrelated Rust panics are resumed, not classified as heap exhaustion.
Lowering either ceiling below current usage refuses the next run even if its
bytecode does not allocate.

These are arena ceilings and bounds on individual guest-sized scratch buffers
and selected logical collections.
They are not a cap on total process memory or aggregate side-table memory, and
they do not turn every Rust allocator failure into a recoverable outcome.
Allocation-pressure GC and chunk reclamation remain separate work.
Heap ceilings are host policy, not snapshot state; hosts must reapply custom
limits after restore.

## Regexp work and storage

`compile_checked` accepts a work budget and an optional cumulative-charge
callback.
The source compiler threads the same regexp budget through lexing, including
regexp literals in eval.
The VM derives remaining work from its meter state.
Unarmed compilation supplies `u64::MAX`; matching remains bounded by the
remaining representable raw charge, and storage limits apply in both modes.
Successful and syntax-failure tails are charged, and work refusal is distinct
from syntax failure and resource exhaustion.

Compile charges cover scanning, parser nodes, charset copying/comparison,
case-folding, sorting, program measurement, and emission.
Case-insensitive ranges accumulate folded points, sort and deduplicate once,
and merge contiguous ranges into one final set node.
This removes the repeated-growing-union behavior described in F132.

Compile storage limits are 16 MiB of pattern bytes, 1,000,000 nodes, 64 MiB of
emitted code, and 64 MiB of cumulative parser payload, including transient
charset copies.
The matcher checks work during backtracking and bounds its saved states at
65,536 and 64 MiB, including capture snapshots.
A resource refusal maps to `HeapExhausted`; a work refusal maps to `MeterAbort`.

## Cost table and validation

W2 landed under **`ironhorse-meter-4`**.
The current compiler-policy release is `ironhorse-meter-5`; it retains W2's
execution weights and these execution-only raw totals.
Moving admission before later guest exceptions changes retained charges, and
new parser, conversion, collection, and formatting work has explicit costs.
Completed armed and unarmed runs agree under version 4.
This release builds on the shared UTF-16 prices and compilation meter from
versions 2 and 3; their digest ledger entries remain unchanged.
Pure regexp matching retains the existing XS schedule, but regexp compilation
and the newly charged builtin work deliberately have version-4 totals.
Historical snapshots with a different cost-table identity fail the gate.
Migration tests use synthetic stores with the current boot identity to test
the independent format migration path; historical fixtures remain unchanged
and are refused when their boot fingerprint or cost-table identity is missing.

Regression coverage includes `allocation_admission_audit`, `heap_ceiling`,
`meter_bounds`, `native_recursion_budget`, regexp `work_limits` and compile
budget tests, snapshot migration/cost-table tests, and the `endo` Machine meter
bounds suite.
Frozen totals cover successful work, caught late failures, regexp compilation,
replacement protocol, Unicode trimming, JSON parsing, argument collection, and
BigInt radix conversion.
Each implementation commit was preceded by an adversarial subagent review and
resolution of its actionable findings.

W2's previously completed recursion work and W2.7/F040 fuzz-target work are not
part of this allocation follow-up.
