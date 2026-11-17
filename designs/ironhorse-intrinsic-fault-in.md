# Ironhorse: fault in pending intrinsic members on a property miss

| | |
|---|---|
| **Created** | 2026-10-16 |
| **Author** | kumavis (prompted) |
| **Status** | Proposed |

## What is the Problem Being Solved?

Ironhorse installs an intrinsic's members lazily, and decides which to install
from names.
A link installs every member whose name has an id; a run-time intern of a new
name installs its members at the next install pass
(`install_pending_intrinsics`); reflecting on an intrinsic completes its whole
surface (`materialize_intrinsic_own_surface`).
Around that core sit guesses about reads the program does not spell:

- source-name gates that install whole surfaces when the program names `Date`,
  a typed array, `Intl`, an Error constructor or an accessor's owning
  constructor (`install_named_intrinsic_bindings`);
- dependency interns for reads natives make implicitly
  (`intern_intrinsic_dependencies`, and the set-method, iterator-helper,
  `Array.from`/`Object.fromEntries`/`AggregateError`/`Math.sumPrecise`/`Iterator.concat`,
  collection-constructor, `toJSON`/`toISOString`, `groupBy` and `fromAsync`
  blocks in `link.rs`);
- the names every link interns (`toString`, `valueOf`, `join`, `name`,
  `message`);
- about a dozen run-time sites that call `install_pending_intrinsics` after
  interning a key a native is about to read (`property/keys.rs`, `iterable.rs`,
  `natives/array.rs`, `natives/promise.rs`, `eval.rs`, and `intern_implicit_key`
  for `toJSON` and `toISOString`).

Each guess that is missing is observable.
On #1465's restack, before `intern_implicit_key`, `JSON.stringify(new Date(0))`
gave `{}` on six paths that reach `Date` without a new name: a later crank,
`eval`, `Function`, a Compartment, and a computed name in the first crank and
later.
Every new native that reads a member implicitly needs its own entry, and
nothing fails until a program takes the path no entry covers.

## Design

Make the laziness unobservable: a [[Get]], [[HasProperty]] or
[[GetOwnProperty]] that misses on an intrinsic holder still owing members
installs the one it asked for, then answers.

### Pending state

Each holder in `INTRINSIC_KEY_ORDER` gets a bitset over its ranks: bit *r* set
means the member at rank *r* has been installed.
A member is pending while its bit is clear.
Installing sets the bit; a guest's deletion leaves it set, so "deleted" is a set
bit with no property, distinct from "never installed".
F079's rule follows: a deleted member is never installed again, and a guest key
added later goes last.

A holder slot carries one internal flag, "has pending members", cleared when
its last bit is set.

### The miss check

`find_property(holder, id)` stays as it is.
In the MOP's ordinary [[Get]], [[HasProperty]] and [[GetOwnProperty]], a miss on
a holder whose flag is set looks up `rank(holder, id)` in that holder's
`IntrinsicKeyRanks`.
If the rank's bit is clear, it installs the member, unmetered, at its rank
(`place_intrinsic_key`), sets the bit and retries.
A hit costs nothing new.
A miss on a holder with no pending members costs a flag test.
A miss on a holder with pending members costs two hash probes and a bit test.

Operations that observe a holder's whole key set complete it first, as the
`pending_surfaces` path does today: [[OwnPropertyKeys]], a guest's first new key
on the holder (so guest keys follow every member), and the integrity
operations (`preventExtensions`, `freeze`, `harden`, `lockdown`).

The global object keeps its standard bindings eager, in XS's order, as #1465
installs them.

### What it would replace

- The source-name gates and the guard names on `proto_accessors`.
- `intern_intrinsic_dependencies` and the dependency blocks listed above.
- The run-time `install_pending_intrinsics` calls and `intern_implicit_key`.
- The installed-names floor (`NFLR`) as the deletion guard: the bitsets carry
  it per member.
- Most of `materialize_intrinsic_own_surface`, which becomes "set every bit".

Link would then install only the global bindings.
A program's names would no longer install members on unrelated objects: today a
program that spells `get` installs `Map.prototype.get`, `WeakMap.prototype.get`,
`Reflect.get` and every other holder's `get`.

### Internal reads

The hazard is code that reads an intrinsic's member with `find_property`
directly, bypassing the MOP: fast-path checks such as
`array_iterates_intrinsically`, species lookups and the iterator drivers.
Each such site either goes through the MOP or calls a `find_intrinsic_member`
that applies the same check.
An audit lists every `find_property` whose holder can be an intrinsic; a
debug-build assertion that no intrinsic holder with pending members is probed
raw keeps the list closed.

## Cost and saving

Measured on #1465's restack (llm `b4d33dbb` with #1462 and #1465), release
build, a fresh machine linked against one program:

| Program | Heap slots |
|---|---|
| `0` | 1,099 |
| names `Date`, `Intl`, `Uint8Array` and `Error` | 1,302 |
| reflects on every reachable intrinsic | 14,995 |
| the same, skipping `Intl` and `Temporal` | 12,039 |

So the source-name gates install about 200 slots that a program naming those
four globals may never touch, and a complete surface is about 13,900 slots
beyond a trivial link, about 2,950 of them Intl and Temporal.
Most of a trivial link's 1,099 slots are boot objects and the global bindings,
which this design keeps.
The saving is therefore in typical programs, which today pay for every holder
whose member names they spell and every surface they gate, not in a trivial one.

The natives themselves are boot-minted function objects, created whatever this
design does.
An edge device saves Intl's and Temporal's property slots, not their function
objects.
Creating natives lazily too is a further, larger step: it changes the boot heap
every fingerprint and restore depends on.

The miss check's cost is the second hash probe on misses along chains whose
holders still owe members.
`Object.prototype` is on almost every chain, so a plain object's absent-key read
pays it until `Object.prototype` is complete.
Installing `Object.prototype` and `Function.prototype` eagerly (a few dozen
members) would keep the common miss at a flag test.
That needs measuring with `benches/run.py` before choosing.

## Persistence, metering and determinism

The bitsets persist as one small-state row, keyed by the holder's index in
`INTRINSIC_KEY_ORDER`, which the boot fingerprint already covers.
At one bit per member they take a few kilobytes at most for a complete realm;
`gc_machine.rs`'s small-state ceiling grows by that.
An image written before the row is refused with `BootLayoutMismatch`, like any
boot-layout move; deriving the bits from the old floor (a member whose name id
is at or below it is installed or deleted) is possible if images must carry
over.

Installation stays unmetered, as boot work, and the miss check charges nothing,
so no computron moves.
The golden vectors should confirm that.
Every replica runs the same guest operations, so each installs at the same
miss; heap layout already depends on install order today.
A lazily resumed machine reads the bitsets with the small state, so it faults in
exactly where its live twin does.

## Phased implementation

1. Add the bitsets and their row beside the floor, set them wherever members
   are installed today, and assert in debug builds that they agree with the
   floor.
2. Add the miss check to the MOP and the audited internal reads, keeping every
   gate.
   `implicit_member_reach.rs` and `intrinsic_key_order.rs` must pass unchanged.
3. Remove the gates, the dependency interns and the run-time install calls one
   at a time, each with reach rows against XS.
4. Retire the floor (`NFLR`).
5. Separately, consider creating natives lazily.

## Dependencies

| Design | Relationship |
|---|---|
| #1465 (intrinsic key order) | Provides `INTRINSIC_KEY_ORDER`, the ranks and `place_intrinsic_key` this builds on. |
| [ironhorse-known-defects](ironhorse-known-defects.md) | F078 and F079 fix the order and re-add semantics this must keep. |
