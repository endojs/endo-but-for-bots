# Region map: VM and runtime

Reviewed at `62b907421`.

## Architecture

`Interp` owns the slot/chunk arenas, execution stack, current environment,
intrinsic roots, module state, job queue, meter, and per-instance side tables.
The field roster in `interp/state.rs` and generated roots/GC registries reduce
the risk that a newly added table is omitted from a whole-machine traversal.

Slots and chunks use integer references.
The collector marks roots, applies side-table and ephemeron edges, compacts
chunks, sweeps dead owners, and remaps surviving references.
Collection remains consumer-triggered; no current policy collects during a
crank.

Opcode execution returns `Step`/`Halt` outcomes through a central dispatch path.
The object MOP centralizes ordinary and exotic operations, although exotic kind
classification still probes authoritative side tables.
Native call fences keep guest throws inside the correct activation and keep
resource stops terminal.

`Machine` owns host policy and services above `Interp`.
Compartments have distinct environments and evaluators while sharing the Realm's
primordial graph and the machine's arenas, key namespace, and jobs.

## Guest Compartment lifecycle

`construct_compartment` reads options, flips the machine into the shared profile,
creates and activates an environment, inherits compiler policy, copies
endowments and lexicals, restores the caller environment, and finally installs
the instance-to-environment side-table row.

The transition is not atomic.
A failure after environment creation restores only the active environment.
The profile flag and provisional environment remain, which produced F002.

Compiler inheritance copies a weak reference from the creating environment.
The child may remain guest-reachable after the creator's compiler registry entry
is collected, which produced F003.

The design also records three unresolved areas that this map did not promote:

- a guest compartment always receives the standard global set rather than a
  creator-derived ceiling;
- the single machine-wide installed-name floor does not represent per-environment
  materialization;
- sloppy declarations can route initialization through `globalLexicals`.

The first is documented policy, the second lacks a public reproduction, and the
third is already an explicit phase-1 correctness gap.

## Inherited debt confirmed

- F010/F076: no in-crank GC policy; a bounded heap can halt under allocation
  churn even when the eventual live graph is small.
- F075: property-key IDs are a monotone `u16` machine-lifetime resource with a
  reserved engine tail.
- F119: exotic classification remains a measured side-table probe chain; the
  attempted centralized kind index was slower.
- F149: the persistent Realm lexical/Script shape remains incomplete.

## Strengths

- Heap-exhaustion and metering stops cannot be swallowed by guest catch blocks.
- Native recursion has one explicit budget across heavy and light re-entry
  classes.
- Host values carry machine provenance and do not expose raw arena coordinates.
- Jobs, reports, captured functions, and host callables retain defining
  environment context.
- GC visitation and side-table registry tests are broad and mutation-sensitive.
- The guest-compartment, lockdown, realm, dispatch, GC, key-space, and
  probe-chain focused suites passed.

## Not read exhaustively

Every built-in body, Temporal/Intl algorithm, opcode arm, inline VM unit test,
and benchmark target was not read line by line.
The map focused on ownership, environment transitions, collection, dispatch,
metering, and the recent Compartment/Iterator changes.

