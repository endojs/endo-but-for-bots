# IronHorse known defects

A record of defects found by reviewing the `codex/ironhorse-snapshot-hardening`
branch, each verified against the pinned XS 9.0 oracle rather than inferred from
reading code.
This exists so the open items are tracked somewhere durable instead of only in
pull-request comments.

## Provenance

Two independent passes produced this list.

The first was a full-diff code review of the branch against its `llm` merge
base.
The second re-checked all 208 findings from the branch's incremental review log
against the branch head, because that log recorded its own prose claims about
which commits closed which findings and those claims had never been verified.

Every behavioural claim below was reproduced with `ironhorse_262::dual_run`,
which runs the same program on IronHorse and on the pinned XS 9.0 oracle and
compares completion values and the raw 16.16 meter.
Metering claims are decided by `computrons_agree` and the raw meter, never by
result agreement alone.

Each verdict recorded as still-open was then given to a second reviewer whose
only instruction was to refute it.
None of the 111 open verdicts was refuted outright; four were downgraded from
open to partial.
The counts below should be read as the shape of the backlog rather than as an
exact tally: they are agent verdicts, spot-checked by hand on roughly a dozen
cases.

## Crash-class defects

These three abort the host process on valid JavaScript.
They are called out separately because IronHorse runs untrusted guest code by
construction, so a guest-triggerable Rust panic or host stack overflow is a
denial of service on the host and not merely a correctness gap.

All three were reproduced at `e36779514`.

### C1 — Unicode backreference endpoint derived from byte length

Panics the engine.

```js
/(k)\1/iu.test("kK")
```

```
thread 'main' panicked at ironhorse-vm/src/interp.rs:23561:22:
matcher capture ends at a CESU-8 code-unit boundary: 2
```

`CX_CAPTURE_REFERENCE_FORWARD_STEP` computes `target = offset + (to - from)` and
then assigns `offset = target`, discarding the character-wise comparison cursor
(`rust/engine/ironhorse-regexp/src/matcher.rs`, lines 257 and 273).
The backward step does the same at lines 220 and 236.
The resulting offset lands mid-code-unit, and the `.expect` on the offsets
binary search in `interp.rs` turns that into a panic.

Logged as `F090`.

### C2 — Unbounded recursion through copied native Iterator setters

Overflows the host stack, exit 134.

```js
var d = Object.getOwnPropertyDescriptor(Iterator.prototype, 'constructor');
var o = {};
Object.defineProperty(o, 'constructor', d);
o.constructor = 1;
```

`iterator_prototype_setter` re-enters through `self.mop_set(...)` when an own
descriptor exists, and that native-accessor re-entry never passes through
`dispatch_at`'s `DISPATCH_REENTRY_LIMIT`, so nothing bounds the recursion.

Logged as `F130`.

### C3 — Bound-function chains recurse in Rust

Overflows the host stack, exit 134.

```js
var f = function () { return 1 };
for (var i = 0; i < 20000; i++) { f = f.bind(null) }
f()
```

`invoke_value` self-recurses once per bound wrapper with only a `tick_raw` and
no modeled-stack accounting.
The iterative fold that would avoid this exists only for construction
(`enter_construct_bound`).
Building the same 20,000-deep chain without calling it completes on both
engines, which pins the overflow to the call path rather than to chain
construction.

Logged as `F172`.

## Status of the crash-class defects

All three are fixed on this branch, with regression coverage in
`rust/engine/ironhorse-262/tests/crash_class_defects.rs`.

C1's forward step now adopts the character-walking cursor.
Its *backward* (lookbehind) step deliberately keeps XS's byte arithmetic:
rewriting it to step back one character per captured character looks more
principled and regresses plain `u`/`v` mode with no folding at all, because XS's
arithmetic can legitimately land on a surrogate boundary inside a pair that a
code-point walk skips over.
The length asymmetry that arithmetic mishandles is real, but it has no known
reproducer that reaches the code-unit assertion, and XS mishandles it the same
way, so faithfulness wins there.

C2 is bounded on the existing native re-entry counter and degrades to
`Halt::StackOverflow`.
The recursion itself is specified -- `SetterThatIgnoresPrototypeProperties`
step 5 is an ordinary `Set` -- and the pinned XS does not complete this program
either, aborting at about 8,180 computrons.
The fix is that IronHorse reports a halt the host can observe instead of
overflowing the real thread stack.

C3 folds bound chains iteratively, as construction already did, and now
completes a 20,000-link chain exactly as the pinned XS does.
The meter on deep chains drifts from the oracle, but by the same amount before
and after the fold, so that drift is a separate pre-existing item.

### Divergences the C1 fix introduces

Fixing the forward step makes IronHorse *disagree* with the pinned oracle on
folds whose encoded lengths differ, because XS leaves its cursor mid-character
and then compares against a replacement character.
IronHorse is right and the pin is wrong in these cases; a randomized
cross-check against an independent reference put IronHorse at zero wrong
answers and the pin at 112 of 356.

Two are pinned explicitly as standards-beyond-the-oracle cases:
`/(ſ)\1/iu.test("ſs")` and `/(ᲀ)\1/i.test("ᲀВ")`, both `true` under the
language and `false` on the pin.
Note the second takes plain `/i` with no `u` flag.

## Status of the apply and arguments-object defects

`F173`, and `F177` through `F180`, are fixed.
Regression coverage lands in `ironhorse-262/tests/native_callable_invocation.rs`
and `tests/errors_coercions_strict.rs`, and in the sqlite store's
`tests/engine_lifecycle.rs` so the behaviour survives snapshot round-trips.

All five are the same root cause seen from five angles.
IronHorse backs an `arguments` exotic object with the same `arrays` side table
it uses for a real Array, so every fast path keyed on
`self.arrays.contains_key(..)` also fired for `arguments` and read raw compact
storage where the specification wants the property MOP.

`F179` was the sharpest of them, an observable wrong answer rather than a
metering gap.

```js
(function (a) { return (function (x) { return x }).apply(null, arguments) })(1)
```

The oracle returns `1`; IronHorse returned `[object Object]`.
A *mapped* arguments object stores a `Kind::Closure` cell in its compact item so
the parameter binding stays live, and `array_item_value` dereferences that cell
on the ordinary read path.
The dense-apply shortcut read `data.items()[&i]` directly, bypassing that
projection, and forwarded the cell itself as the argument.
`F180` is the same shortcut in `AggregateError`.

```js
(function () { arguments.length = 1; return new AggregateError(arguments).errors.join(',') })(1, 2)
```

The oracle returns `1`; IronHorse returned `1,2`.

Both shortcuts now exclude arguments objects and route them through
`CreateListFromArrayLike`, which also closes `F177`: `arraylike_length` no
longer answers `Get(arguments, "length")` out of the array side table, so an
assigned, deleted, or redefined `length` is honoured.

`F178` and `F173` are the metering consequence.
The generic `CreateListFromArrayLike` walk was charged nothing beyond the reads
it performed, leaving `Math.max.apply(null, {length: 2, 0: 3, 1: 8})` at 36
computrons against the oracle's 38.
The residual is now charged by a shared helper at all three apply sites -- the
two opcode trampolines and the abstract dispatcher that a bound or proxied
`apply` reaches -- with a credit for the metering an ordinary object or an
arguments object has already paid through its property MOP path.
Dense Arrays and Proxies keep the full array schedule and are unchanged.

`apply_array_like_reads_are_computron_exact` holds these to raw-meter equality
with the oracle rather than result agreement, so the credits cannot drift
silently.

### The residual this leaves

Routing `Get(arguments, "length")` through the property MOP is not free, and it
over-charges by roughly 15,600 raw units per read against the pin.
`examples/probe_apply_repeat.rs` isolates it: ten iterations of
`f.apply(null, {length: n, ...})` where the callee returns a constant now land
within one computron of the oracle, and the same ten iterations where the callee
returns `arguments.length` land two computrons high, at every arity.
The flatness across arity is what identifies the read rather than the walk.

Whether the walk itself is right is a separate question and this probe answers
it well: on the generic array-like shapes the gap moved from 10, 18 and 25
computrons low at arities 0, 1 and 2 to 0, 0 and 1, and a bound `apply` moved
from 2 low to exact.
An `arguments` object forwarded to `Math.max.apply` moved from 5 high to 2 low
over ten calls.

So the apply walk is calibrated and the arguments-object `length` read is the
next item, worth about a quarter of a computron each time a guest reads it.

`AggregateError` carries a second residual, and it is a trade rather than a
regression.
`new AggregateError(arguments)` used to answer from the dense shortcut, which
was one computron low and, for the shapes `F180` names, gave the wrong answer.
It now takes the generic iterable path, which is right and runs one to four
computrons high, growing with arity at roughly 65,500 raw units per element.
That is the generic-iterable calibration itself, not something arguments
objects do: an ordinary array-like carrying `Array.prototype[Symbol.iterator]`
is three computrons high at the same arity, and a dense Array is still exact.
`F181` is where that belongs, so no third credit is spent here to hide it.

## A harness caveat worth knowing

The pinned oracle's answer for a program in this family can depend on which
programs ran before it in the same process.
Two runs of `/(k)\1/iu.test("kK")` immediately followed by
`/(K)\1/iu.test("Kk")` make the oracle answer `false` for the third, where it
answers `true` run alone or with any unrelated program in between.
Both Rust crates are `#![forbid(unsafe_code)]`, so this is oracle-side rather
than corruption from the engine.

The practical consequence is that a divergence observed in a batch means
nothing until the program is re-run in its own process.
Several apparent divergences reported while reviewing the C1 fix evaporated
under that check, so any count of oracle divergences taken from a batch run
should be treated as an upper bound.

## Decisions a maintainer may want to revisit

Three of the choices above were judgement calls made while fixing the
crash-class defects, not conclusions forced by the evidence.
None of them needs action now; they are collected here so they are decided
deliberately rather than inherited by default.

**Diverging from the pin deliberately.**
`folding_backreferences_beyond_the_pinned_oracle` asserts that IronHorse is
right and the pinned XS is wrong for two folded backreferences, which moves this
corner off strict oracle agreement.
The evidence is in "Divergences the C1 fix introduces" above.
Whether the project wants named standards-beyond-the-oracle exceptions at all,
or would rather match the pin and carry the bug, is a doctrine question rather
than a code one.

**Keeping XS's byte arithmetic in the backward step.**
The lookbehind capture-reference step still mishandles the folding length
asymmetry, exactly as XS does.
Faithfulness was chosen because the principled rewrite regressed non-folding
surrogate cases and because no known program reaches the assertion through that
step.
If a reproducer turns up, that trade is worth reopening.

**Treating the 1,000,000-element caps as load-bearing.**
They are left in place because the meter cannot bound a native-only iteration
today.
Adding meter check points inside those loops is the real fix and was
deliberately not attempted as part of a crash-fix change.

## The catalog is a floor, not a ceiling

Everything here came from reviewing this branch's diff and its own review log.
That is not the same as auditing the engine's whole surface, and the difference
showed up almost immediately: an external review of the branch found a
`String.prototype.lastIndexOf` defect that appears nowhere in the 208 logged
findings.

Any position that coerces to NaN must search the whole string (ECMA-262
22.1.3.9 step 6), but only a missing or `undefined` argument was special-cased,
so `"abcabc".lastIndexOf("a", NaN)` answered 0 where the pinned XS answers 3.
`..., "zzz")` and `..., {})` had the same cause.
It is fixed, with coverage in `ironhorse-262/tests/review_fixes.rs`.

The lesson for anyone reading the counts below: they bound what *this* review
found, not what exists.

## Open findings

111 of the 208 logged findings were still open or partial at `fa3ecfcfd`, 83 of
them P1.
Roughly 48 are metering calibration against the pinned oracle and roughly 63 are
behaviour divergences a guest program can observe; the distinction matters for
triage.

A handful were closed after that sweep by the review-fix commit on this branch,
notably the `JSON.stringify` index-interning over-charge (`F108`).
The rest are listed here as they stood.

### Snapshot migration and boot versioning

8 open, 4 of them P1.

- `F068` **P1** Do not use a considered `join` as the arguments-layout version (partial)
- `F069` **P1** Encode the boot generation outside the legacy signature namespace
- `F071` **P2** Keep legacy migration-fixture generators on the legacy signature
- `F072` **P2** Treat a null `@@toPrimitive` method as absent
- `F073` **P2** Preserve the pinned missing-key behavior
- `F074` **P1** Make the new coercion tests enforce computron parity
- `F078` **P1** Canonicalize intrinsic ordering for prototypes and namespaces too
- `F079` **P2** Move a deleted-and-recreated intrinsic property to the end

### Object MOP: intrinsics, tombstones, harden, petrify

7 open, 5 of them P1.

- `F081` **P1** Retain ordinary numeric expandos on boxed Strings
- `F082` **P1** Honor deleted function-metadata tombstones throughout the MOP
- `F083` **P1** Throw a catchable TypeError after key coercion
- `F084` **P2** Include RegExp in the full-MOP defineProperty path (partial)
- `F085` **P2** Preserve descriptor field presence for proxy defineProperty traps
- `F087` **P1** Do not expose the queued harden mark to reentrant calls
- `F088` **P1** Enforce petrified ArrayBuffer state in its ordinary view writes

### RegExp engine and copy construction

8 open, 6 of them P1.

- `F089` **P1** Canonicalize the redundant REGX fallback for nonnumeric lastIndex
- `F090` **P1** Do not derive a Unicode backreference endpoint from byte length
- `F091` **P2** Keep the public matcher input encoding consistent with the compiler
- `F092` **P1** Read source and flags before coercing either copy field
- `F093` **P1** Run the observable flags getter during RegExp copying
- `F094` **P1** Preserve lone-surrogate sources through copy construction
- `F096` **P1** Do not fast-path toString past the generic flags getter
- `F097` **P2** Do not treat reaching regexp_proto as proof a property still exists

### Numeric coercion, Math, JSON

11 open, 8 of them P1.

- `F099` **P1** Meter the newly reachable object-to-number conversions
- `F100` **P1** Parse every ECMAScript whitespace character in numeric strings
- `F101` **P1** Coerce the first pow/atan2 argument when the second is missing
- `F102` **P2** Use a scaled algorithm for variadic Math.hypot
- `F103` **P1** Meter the new reviver wrapper and recursive walk
- `F104` **P1** Preserve callable-Proxy identity after revocation
- `F105` **P2** Implement or honestly skip XS's Array parse whitelist
- `F106` **P2** Drop child source records when a container was replaced
- `F107` **P1** Apply ToNumber to a Number-wrapper space value
- `F108` **P1** Do not intern every serialized array index persistently
- `F109` **P1** Charge every index skipped by sparse-array jumps

### Promise combinators, capabilities, thenables

13 open, 6 of them P1.

- `F111` **P1** Invoke `then` on primitive Promise.resolve results
- `F113` **P2** Remove the fixed one-million-yield semantic cap
- `F114` **P1** Model IsConstructor accurately for species values (partial)
- `F117` **P2** Calibrate newly accepted executor shapes (partial)
- `F118` **P1** Preserve a custom then call's arguments and completion
- `F121` **P1** Assert oracle metering on the new static-resolution paths
- `F123` **P1** Support bound constructors in NewPromiseCapability
- `F124` **P2** Preserve NewTarget through default Proxy construction
- `F125` **P1** Preserve both observable species lookups in `finally`
- `F126` **P2** Preserve Promise native names in function stringification
- `F127` **P2** Include every standard Promise static in the completeness gate
- `F128` **P2** Charge for accessor-based thenable probes (partial)
- `F129` **P2** Account for callable `finally` wrapper creation (partial)

### Iterator helpers and intrinsic name resolution

12 open, 10 of them P1.

- `F130` **P1** Contain recursion through copied native Iterator setters
- `F131` **P2** Charge the native accessor invocation residual
- `F132` **P1** Install computed intrinsic names for the `in` operator too
- `F133` **P1** Do not let a computed lookup resurrect deleted built-ins
- `F134` **P1** Calibrate the terminal Iterator-helper metering
- `F135` **P1** Charge derived `Iterator` construction
- `F136` **P1** Meter `INSTANTIATE` according to the selected prototype branch
- `F137` **P2** Preserve left-to-right object-member evaluation
- `F138` **P1** Calibrate `Iterator.from` and wrapper-call metering
- `F139` **P1** Keep `%ArrayIteratorPrototype%.next` brand-specific
- `F140` **P1** Do not enable `Array.of` before its metering is faithful
- `F141` **P1** Preserve the subclass prototype in `Array.of.call(Subclass, ...)`

### Unicode and String algorithms

11 open, 11 of them P1.

- `F142` **P1** Pin the Unicode case-mapping data instead of inheriting Rust's table (partial)
- `F143` **P1** Calibrate expanding Unicode case-conversion metering
- `F144` **P1** Calibrate `String.prototype.normalize` metering
- `F145` **P1** Calibrate every newly enabled `replaceAll` path before claiming support
- `F146` **P1** Do not stop generic replacement before observable capture getters
- `F147` **P1** Let `String.raw` observe segments before applying resource limits
- `F148` **P1** Calibrate `String.raw` metering
- `F149` **P1** Preserve lone-surrogate distinctions in `localeCompare`
- `F150` **P1** Implement the contextual Turkish/Azeri dotted-I rules
- `F151` **P1** Use collation weights for the advertised `localeCompare` options
- `F152` **P1** Calibrate `String.prototype.localeCompare` metering

### RegExp symbol-protocol dispatch

8 open, 6 of them P1.

- `F153` **P1** Calibrate match-all creation and active iteration
- `F154` **P1** Materialize `@@matchAll` before symbol reflection
- `F155` **P2** Support `%RegExp.prototype%` as the generic method receiver
- `F156` **P1** Calibrate direct `RegExp.prototype[@@match]` and its global loop
- `F157` **P1** Calibrate direct `RegExp.prototype[@@search]`
- `F158` **P1** Calibrate custom String-level `@@split` dispatch
- `F159` **P1** Separate generic RegExp split metering from the native fast path
- `F160` **P2** Consult wrapper prototypes for primitive separators (partial)

### String delete, boxing, ArrayBuffer slice and transfer

10 open, 6 of them P1.

- `F161` **P1** Route delete opcodes through String exotic `[[Delete]]`
- `F162` **P1** Meter sloppy String, Symbol, and BigInt boxing
- `F163` **P1** Calibrate each ArrayBuffer slice protocol branch
- `F164` **P2** Make the slice suite enforce the project's meter-parity contract
- `F165` **P1** Reject transfer of a petrified ArrayBuffer
- `F166` **P1** Charge the transfer frame and result allocation
- `F167` **P1** Release inaccessible backing chunks when detaching
- `F168` **P2** Tokenize lone-surrogate input instead of rejecting it up front
- `F169` **P2** Preserve escaped lone surrogates in object keys
- `F170` **P3** Pin the changed Unicode allocation metering

### Bound functions and collection iterables

6 open, 6 of them P1; `F173` since fixed.

- `F171` **P1** Keep recursive bound calls in the iterative dispatcher
- `F172` **P1** Fold long bound chains without Rust recursion
- `F173` **P1** Charge both newly enabled bound-apply forwarding paths (fixed)
- `F174` **P1** Exclude arguments objects from the dense collection fast path
- `F175` **P1** Revalidate iterator hooks after the observable adder lookup
- `F176` **P1** Migrate or reject pre-collection-iterable snapshots

### arguments MOP, Error construction, global environment

14 open, 13 of them P1; `F177` through `F180` since fixed.

- `F177` **P1** Read arguments-object length through the property MOP (fixed)
- `F178` **P1** Meter generic CreateListFromArrayLike reads in apply (fixed)
- `F179` **P1** Dereference mapped arguments in the dense apply shortcuts (fixed)
- `F180` **P1** Exclude arguments objects from AggregateError's dense shortcut (fixed)
- `F181` **P1** Do not add the dense iterator calibration to generic iterables
- `F182` **P1** Apply observable message coercion to SuppressedError too
- `F183` **P1** Calibrate the newly observable Error argument operations
- `F185` **P1** Install Error subtype names before toString can request them
- `F186` **P1** Charge Error-to-string work on abrupt getter and coercion exits
- `F187` **P2** Meter Error-to-string allocation in encoded bytes
- `F188` **P1** Calibrate CopyObject's newly enabled MOP paths
- `F189` **P1** Resolve inherited properties in the global Object Environment Record
- `F190` **P1** Reject strict assignment to an unbound identifier
- `F191` **P1** Charge SET_VARIABLE before rejected or throwing global writes exit

### Array iterator

1 open, 1 of them P1.

- `F197` **P1** Avoid stringifying numeric keys before the own-property probe

## Deliberately not acted on

Two findings from the diff review were retracted after measurement, and are
recorded here so they are not re-raised.

The array-index interning finding does not hold for
`array_generic_create_data_property` or `array_from_define`.
The pinned XS interns the index name on those paths too, and deferring the
intern makes IronHorse 256 raw meter units per element cheaper than the oracle,
which `flat_map_retains_calibrated_dense_metering` catches.
Only the `JSON.stringify` site was a genuine over-charge, and it is fixed.

The Array-Iterator Proxy `mop_get` residual leak is not reproducible.
A one-shot disarm of the transient changed no measurement in any shape probed,
so no speculative metering change was made.
There is a real nearby divergence: extra same-key reads inside a mixed
transparent/active Proxy trap leave IronHorse low, XS 129 against IronHorse 126
for one extra read and XS 191 against IronHorse 182 for three.

The 1,000,000-element iteration caps are a deliberate host-safety idiom at
roughly nine native loop sites, not a per-call-site accident.
The meter cannot replace them as-is: meter check points fire on bytecode
dispatch, so a native-only iteration never reaches one, and `step_limit` is
`u64::MAX` in production.
Removing them would permit an unbounded native loop.
Bounding them properly means adding meter check points inside those loops.
