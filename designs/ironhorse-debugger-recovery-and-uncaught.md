# Ironhorse Debugger: Row Recovery and Native Break-on-Uncaught

| | |
|---|---|
| **Created** | 2026-08-12 |
| **Updated** | 2026-08-14 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Proposed |

This design proposes two things whose order is fixed by a dependency:
first **recover the Ironhorse debugger row** (roadmap stage 7,
[ironhorse-engine](ironhorse-engine.md) § Debugger), which left the
branch before [PR #600](https://github.com/endojs/endo-but-for-bots/pull/600)
merged on 2026-08-06; then land the **break-on-uncaught-exceptions**
feature natively on the recovered row, oracle-locked to Moddable XS the
way the rest of Ironhorse is. It follows the research in
[issue #940](https://github.com/endojs/endo-but-for-bots/issues/940) and
supersedes the *"Augmentation: Break on Uncaught Exceptions Only"*
section of [daemon-xs-worker-debugger](daemon-xs-worker-debugger.md) for
the Ironhorse engine. C-XS remains a behavioral oracle, not a second
implementation target: once Ironhorse reaches parity, C-XS retires.

All claims that motivated this design were re-verified against the
current `llm` head (`0ac48c54b`), not the head the research was written
against. Every one still holds; the engine-raise finding is stronger
than first reported.

## What is the Problem Being Solved?

The Endo client stack already ships a three-way exception-break control —
`packages/daemon/src/debug-session.js` `setExceptionBreakMode('none' |
'all' | 'uncaught')`, exposed on the CapTP `Debugger` exo
(`packages/daemon/src/debugger.js`) and driven by a Chat panel — but
**no engine implements the `uncaught` arm**. The maintainer directive of
2026-07-28 is the target behavior: *it should be obvious from the stack
whether there is a catch above the throw.* Ironhorse can answer that
question more cheaply than XS can, because its live handler chain is a
structural predicate rather than a flag walk. But the debugger row that
would host the answer is not on the branch, so nothing can land until it
is recovered.

The research yielded three Ironhorse work items, the first blocking the
other two:

1. **Recover the debugger row** — the `endor-debug` crate and its VM seam
   left the branch.
2. Ironhorse's **engine-raised errors do not unwind** through the jump
   chain — an uncaught mode built on the chain cannot see a single
   engine `TypeError`.
3. Three `BreakpointTable` **parity nits** versus the XS oracle.

The research also confirmed that `setExceptionBreakMode('uncaught')` is
a silent no-op on C-XS. This design does not extend that retiring engine;
the mode becomes live when the client attaches to Ironhorse.

## Part 1 — Recovering the Debugger Row

### What is on the branch, and what is not

The row shipped as three slices, still present as **unreachable objects**
(fetchable, not on any ref) in a clone that saw the old branch state:

| slice | commit | content |
|---|---|---|
| 1 | `2b6a8d7070` | `endor-debug` crate: `DebugTransport` trait, `CommandParser`, `Echo` serializer (protocol core, a leaf crate) |
| 2 | `6bac90c221` | VM seam: `endor-vm::debug` (`DebugHook`/`DebugCtx`), `BreakpointTable`, `StepMode`, `DebugSession` |
| 3 | `8024ee3f55` | end-to-end lifecycle acceptance test over the in-memory transport against a live `Interp` |

Their merge-base with the current `llm` head is `00a04f5b4` (2026-07-18),
now **505 commits** back. In that window two things happened that make a
literal recovery impossible:

- **A wholesale crate rename**: `endor-vm -> ironhorse-vm`,
  `endor-compile -> ironhorse-compile`, `endor-262 -> ironhorse-262`,
  `endor-oracle -> xs-oracle`, `endor-{regexp,snapshot,fuzz}`
  -> `ironhorse-{regexp,snapshot,fuzz}`. The debugger crate's own target
  name is now `ironhorse-debug`, as [ironhorse-engine](ironhorse-engine.md)
  § Minimizing `unsafe` already lists among the `forbid(unsafe_code)`
  roots.
- **A rewrite of the interpreter**: `ironhorse-vm/src/interp.rs` is now
  ~19,000 lines, with the full 245-opcode object-model and control-flow
  surface that slice 2's 244-line seam was written against a much smaller
  interpreter to touch.

### Recommendation: a fresh builder slice, not a weaver rebase

**Recover by re-deriving, not by cherry-pick.** A weaver rebasing the
three commits onto `llm` would hit a rename-and-rewrite wall: every path
under `rust/engine/endor-*` is gone, and slice 2's `interp.rs` hunks
target dispatch code that no longer exists in that shape. The conflict
surface is the whole engine, so the rebase would degrade into a manual
re-write done under the worst possible tool — a three-way merge — instead
of a clean re-derivation.

The slices remain **first-class reference material**, and the split they
established is still exactly right:

- **Slice 1 ports nearly verbatim.** `endor-debug` is a leaf crate that
  depends on nothing; its `CommandParser` (a transliteration of
  `fxDebugParse`), `Echo` serializer (`fxEchoString` byte-exact escaping,
  `<xsbug>` CRLF framing), and `DebugTransport` trait are engine-version
  independent. Re-land them as `ironhorse-debug` with the rename applied
  and the 28 tests carried over.
- **Slice 2 must be re-derived against today's `ironhorse-vm`.** The seam
  shape holds — `ironhorse-vm` gains an `Option<Box<dyn DebugHook>>`
  invoked at the `line`/`debugger` opcodes, with a read-only `DebugCtx`
  inspection surface, and `ironhorse-debug` links `ironhorse-vm` and
  implements the hook. But `debug_frames`/`debug_globals`/`debug_locals`
  now read the current arena/frame model, and the hook call site is a new
  line in the rewritten dispatch loop. The report confirms the VM has
  **no** debug hook of any kind today (only the semantics-free `debugger`
  opcode marker), so this is new integration, not a merge.
- **Slice 3's acceptance test carries over** once slices 1 and 2 land.

**Build owner: a fresh `builder` slice** (three sub-slices mirroring the
originals), dispatched against current `llm`, with the unreachable
commits named in the brief as the reference to transliterate from. This
is the [ironhorse-engine](ironhorse-engine.md) stage-7 work, and it
carries stage 7's acceptance bar unchanged: *the existing 11 Rust
debug-protocol tests and 16 CapTP debugger tests pass unmodified against
Ironhorse; an Endo debugger client connects.* xsbug compatibility is not
an acceptance constraint: the Ironhorse debugger protocol may express
state that xsbug cannot. A `weaver` is the wrong tool because there is no
coherent branch to weave.

Fold the three **parity nits** into slice 1's re-land rather than
filing them separately, since the code that carries them
(`breakpoints.rs`) is exactly the code being recovered:

1. **Guard the pseudo-breakpoint on `line == 0 && id == 0`.** XS's
   `fxSetBreakpoint` recognizes `path == "exceptions"` only when both
   `theID` and `theLine` are zero; the slice's `BreakpointTable::set`
   drops `id` entirely and matches `path == "exceptions"` at any line, so
   `<set-breakpoint path="exceptions" line="12"/>` would arm the
   pseudo-breakpoint where XS sets a real line-12 stop in a file named
   `exceptions`. Restore the guard and thread `id` through `set`/`clear`.
2. **Port the `start` pseudo-breakpoint.** XS's `fxSetBreakpoint` also
   recognizes `path == "start"` (line 0) -> `breakOnStartFlag`; the slice
   omits it. Add it as a second flag on the table.
3. **Delete the phantom `"unhandled"` doc.** `BreakpointTable`'s module
   doc asserts a `path == "unhandled"` pseudo-breakpoint exists in XS. It
   does not occur anywhere in `xsDebug.c` at the pinned
   `23b4d6b0` (Moddable 8.3.1). Remove the reference; unhandled-rejection
   reporting is a separate mechanism (see § Promise rejection).

## Part 2 — Native Break-on-Uncaught

### The classifier: a structural predicate, not a flag walk

Ironhorse keeps the live handler chain as `Interp.jumps: Vec<CatchJump>`
(interp.rs, `jumps` field), innermost last, whose own doc comment states
the load-bearing fact: *an empty chain means the throw escapes every JS
handler and propagates to the host boundary as `Halt::Throw`*. There are
no host entries in the chain — XS's `jump->flag == 0` host boundary has
no analogue in Ironhorse — so the base predicate for "will this throw
escape all JS handlers?" is:

```text
self.jumps.is_empty()
```

constant time, no allocation, no walk, and **exact** with respect to what
`unwind_to_jump` will actually do. This is strictly cheaper than XS's
`firstJump` walk testing `jump->flag`, and it is the reason
[daemon-xs-worker-debugger](daemon-xs-worker-debugger.md)'s C-XS
`breakOnUncaughtExceptionsFlag` sketch does not carry over unchanged: the
Rust engine replaces a flagged list walk with a length check.

**The `finally`-without-`catch` exception, and its exact fix.**
`ironhorse-compile`'s `code_try` (coder.rs `fn code_try`, the port of
`fxTryNodeCode`) emits a single `XS_CODE_CATCH_1` for a finally-only
`try`, indistinguishable *in kind* from a real catch — so a naive
`is_empty()` reports `try { throw 7 } finally {}` as "caught" while the
exception is only transiting the finally block (verified by executed
probe: it still reaches the host as `Halt::Throw`). The exact fix needs
**no bytecode change** — peek one byte at the handler's `target_pc`:

- a **real catch** clause emits a *second* `XS_CODE_CATCH_1` that the
  first one targets, so `code[target_pc]` is in the `CATCH_1/2/4` family;
- a **finally-only** `try` places its single `CATCH_1` target directly on
  the `XS_CODE_EXCEPTION` opcode (coder.rs: `place_target` immediately
  before `add_byte(1, XS_CODE_EXCEPTION)`).

So classify a chain entry as a genuine catch when `code[target_pc]` is a
`CATCH_*` opcode, and as finally-only transit when it is
`XS_CODE_EXCEPTION`, in which case keep scanning outward. A throw is
uncaught when no entry in the chain is a genuine catch. This falls
straight out of the coder's emission order, is deterministic because the
coder is oracle-locked to `fxTryNodeCode`, and is **implementable
from the same bytecode model** (`jump->code` points at the corresponding
bytecode in XS). It is a better answer for Ironhorse than the superseded
design's `flag == 2` compiler change, which would perturb emitted bytecode
and break the port's byte-identity acceptance bar.

### Prerequisite: engine-raised errors must unwind

**This is a hard prerequisite, not a nicety.** Verified against current
`llm` and *stronger* than the research first reported: engine-internal
errors build `Halt::Throw(...)` inline at each site and return it
directly out of dispatch — `enter_call` "call: not a function"
(interp.rs, `enter_call`), `XS_CODE_GET_LOCAL` "get: not initialized
yet", `XS_CODE_GET_VARIABLE` "undefined variable", the cyclic-value and
symbol-coercion `TypeError`s, and others. There is **no centralized raise
/ throw_error helper**; `unwind_to_jump` is reached *only* from the three
real JS throw sites (`XS_CODE_THROW`, `XS_CODE_RETHROW`, and the rejected-
`await` `ResumeStatus::Throw` path). Consequence, confirmed by probe:
`try { var f; f() } catch (e) {}` does **not** catch the engine's
`TypeError` — it escapes to the host.

C-XS routes this whole class through `fxThrowMessage`, which both calls
`fxDebugThrow` and `fxJump`s into the chain. Until Ironhorse gains a raise
path that unwinds through `jumps`, a break-on-uncaught mode built on the
chain will simply never see an engine-raised error. This is a **VM parity
item** that bounds what the debugger feature can deliver, and it must land
before (or with) the uncaught mode. The shape: a single
`raise(&mut self, msg) -> Halt` helper that pushes the error value and
routes through the same `unwind_to_jump` path the `XS_CODE_THROW` handler
uses, replacing the inline `return Halt::Throw(...)` sites. Its own
acceptance bar is a dual-run test that `try/catch` catches each class of
engine-raised error, matching XS. Track this as a named sub-slice of the
build (*"engine-raise unwinds through the jump chain"*), or as a sibling
VM PR the debugger row depends on; it is not optional and must not be left
as a bare "follow-up".

### Protocol: the `uncaughtExceptions` pseudo-breakpoint (option A)

The wire grammar settles the protocol shape. The xsbug command parser
recognizes exactly three attribute names — `path`, `line`, `id` — and
discards any other attribute value byte by byte (the `Attribute::Unknown`
case in the port; the `XS_*_ATTRIBUTE` cases in `fxDebugParse`). So:

- **A mode *attribute*** (`<set-breakpoint path="exceptions" mode="uncaught"/>`)
  is silently dropped by any engine or client that does not know it — the
  worst failure mode for a debugger control. Rejected.
- **A second pseudo-path**, `<set-breakpoint path="uncaughtExceptions"
  line="0"/>`, needs **no parser change**: it is one more string compare
  in `BreakpointTable::set`/`clear`, and an engine that does not implement
  it degrades to a harmless never-hit breakpoint rather than a misparse.
  **Chosen** — and it is exactly what the shipping client already sends,
  so adopting it costs zero client work.
- **Generalizing `<breakpoint-condition>`** is the most work for the
  least fit (the pseudo-breakpoint deliberately creates no slot for a
  condition to attach to). A reasonable future mechanism for real
  conditional breakpoints; the wrong vehicle for a machine-wide mode.

Two independent flags (`break_on_exceptions`, `break_on_uncaught`) yield
the three modes the client vocabulary speaks — `none`, `uncaught`, and
`all` (`break_on_exceptions` takes priority when both are set, matching
the superseded design). These are the complete required mode set;
caught-only breaking is out of scope.

**Report the classification back** as a new `caught` attribute on the
break echo: `<break path="..." line="..." caught="0">`. `<break>`
otherwise carries only `path` and `line`, and for a throw the body is
already the rendered exception, so there is no existing field to reuse.
`debug-session.js` parses attributes generically and reads only
`path`/`line`, so it ignores the attribute until a one-line client change
surfaces it. The Endo client is the compatibility target. Ironhorse may
extend the protocol beyond what xsbug can express.

### Retiring the C-XS no-op

`setExceptionBreakMode('uncaught')` currently sends `clear exceptions` +
`set uncaughtExceptions` (`debug-session.js`, verified still present at
the current head). On the shipping **C-XS/xsnap** path, `uncaughtExceptions`
is not a recognized pseudo-path, so `fxSetBreakpoint` falls past its guard
and registers an ordinary line-0 breakpoint on a phantom file named
`uncaughtExceptions` (which nothing ever hits) while the same call clears
`exceptions`. Net effect: **selecting `'uncaught'` silently turns
exception breaking off.** This is evidence for completing Ironhorse
parity, not a new C-XS workstream. Do not add a fallback, capability
negotiation, or alias to C-XS. Once Ironhorse implements
`uncaughtExceptions`, the existing client command becomes live; retire
C-XS when Ironhorse reaches parity.

### Cost when disarmed, and the acceptance property

The classifier lives inside the throw hook, behind the same single
dormant branch the stepping seam established — a `None`
`Option<Box<dyn DebugHook>>` (or, per the recommendation below, a `Copy`
mode enum on `Interp`) tested at the throw sites `XS_CODE_THROW`,
`XS_CODE_RETHROW`, the rejected-`await` throw path, and eventually the
engine-raise path. Throws are rare compared with `line` opcodes, so this
is **strictly cheaper** than the stepping seam already accepted for the
row. Armed, the added cost is one `Vec::is_empty` plus at most one array
index per finally-only handler on the chain — no allocation, no walk in
the common case, and the hook never touches the meter.

**Carry the row's standing acceptance property as a required test, not an
assertion:** a run is computron-exact between the disarmed debugger and
the pre-feature build, and an *attached-but-mode-off* debugger costs the
same as no debugger at a throw it does not stop on. Recommendation: test
a small `Copy` mode field on `Interp` at the throw sites rather than
`Option::is_some()`, so an attached-but-off debugger is a register
compare. This is the same equal-computron bar slice 2 held for the
stepping seam.

## Ironhorse Decisions Informed by the XS Oracle

1. **Hook `XS_CODE_RETHROW`, which C-XS does not hook.** Without it, an
   exception transiting a finally-only `try` produces no stop at all in
   uncaught mode; with it, Ironhorse stops where C-XS would not.
   Recommend hooking and documenting it as an improvement.
2. **The target-opcode peek** makes Ironhorse's classification strictly
   better than XS's flag walk without changing oracle-locked bytecode.
3. **Promise rejection is out of scope, and the UI must say so.** XS
   tracks unhandled rejections in a separate weak list
   (`fxAddUnhandledRejection` / `fxCheckUnhandledRejections`) reported
   only at drain or exit, never through `fxDebugThrow`. An unhandled
   rejection is not a stack-visible uncaught throw; no throw-time
   classification will find it. The UI wording must not let `uncaught`
   read as `unhandled`. Ironhorse's promise-reaction throw path is not
   implemented yet (self-named `Halt::Unsupported("promise:handler-throw")`);
   when it lands, its host boundary must be visible to the classifier so
   a rejection-producing throw is not misreported as uncaught.

## Dependencies

| Design | Relationship |
|---|---|
| [ironhorse-engine](ironhorse-engine.md) | This is stage-7 (§ Debugger) work; recovers the row that design plans and adds break-on-uncaught as § Debugger promised ("the `uncaughtExceptions` pseudo-breakpoint lands in stage 7") |
| [daemon-xs-worker-debugger](daemon-xs-worker-debugger.md) | Supplies the consumer contract (bus verbs, `DebugSession`, `Debugger` exo, UI); this design **supersedes** its *"Augmentation: Break on Uncaught Exceptions Only"* section for the Ironhorse engine (`flag == 2` compiler change -> target-opcode peek; C-XS `firstJump` walk -> `jumps.is_empty()`) |
| [issue #940](https://github.com/endojs/endo-but-for-bots/issues/940) | The grounding research this design is written from |

## Phased Implementation

Dependency order; the first phase blocks every other.

1. **Recover slice 1 as `ironhorse-debug`** — protocol/transport/parse/
   serialize core, transliterated from `2b6a8d7070` with the rename
   applied, the 28 tests carried over, and the three parity nits fixed
   in `breakpoints.rs` (guard, `start` pseudo-breakpoint, phantom doc).
2. **Recover slice 2** — the `ironhorse-vm::debug` seam (`DebugHook` /
   `DebugCtx`), re-derived against today's `interp.rs` dispatch loop and
   arena model, with `ironhorse-debug` implementing the hook. Land the
   11 Rust debug-protocol tests.
3. **Recover slice 3** — the end-to-end lifecycle acceptance test, and
   turn on the 16 CapTP debugger tests against Ironhorse (stage-7 bar).
4. **Engine-raise unwind (prerequisite for 5)** — the `raise` helper that
   routes engine-internal errors through `unwind_to_jump`; dual-run test
   that `try/catch` catches each class of engine-raised error.
5. **Break-on-uncaught** — `break_on_uncaught` flag on the table, the
   `uncaughtExceptions` pseudo-path, the throw-site hook with the
   `is_empty()` + target-peek classifier over `XS_CODE_THROW` /
   `XS_CODE_RETHROW` / rejected-`await` / engine-raise, the `caught`
   attribute on `<break>`, and the equal-computron acceptance test.
## Design Decisions

1. **Re-derive, do not rebase.** 505 commits and a wholesale crate rename
   make a literal cherry-pick a whole-engine merge conflict; the slices
   are reference material, not a mergeable branch. A `builder`, not a
   `weaver`.
2. **`jumps.is_empty()` + target-opcode peek**, not a flag walk and not a
   `flag == 2` compiler change: exact, allocation-free, and keeps
   byte-identity with the oracle compiler.
3. **Option A (`uncaughtExceptions` pseudo-path)**, because the wire
   grammar drops unknown attributes and routes unknown paths to a
   harmless never-hit breakpoint, so it degrades safely on every
   engine/client combination and matches the already-shipped client.
4. **Exactly three modes: `none`, `uncaught`, and `all`.** Caught-only
   breaking is not required and is out of scope.
5. **Engine-raise unwind is a gating prerequisite**, not a follow-up:
   without it the mode cannot see a single engine `TypeError`.
6. **Metering neutrality is a test, not a claim** — equal computrons
   armed-off and disarmed, matching the stepping seam's bar.

## Prompt

> Design: xs2rust-endor debugger, following on #600. Before it merged, the
> researcher report found the debugger row had left the branch and named
> four follow-ups (the first blocking the other three): (1) recover the
> debugger row — figure out where it lands now, don't restate the stale
> "recover onto #600"; (2) `setExceptionBreakMode('uncaught')` is a live
> silent no-op; (3) Ironhorse's engine-raised errors do not unwind through
> the jump chain; (4) three `BreakpointTable` parity nits. Verify 2-4
> against the current merged engine before designing. Propose the recovery
> path and fixes for whichever of 2-4 are still live, oracle-locked to the
> XS debugger's actual behavior. Land as a draft PR against `llm`. Name
> who should build it (weaver recovering the row vs. fresh builder) as an
> explicit recommendation.
