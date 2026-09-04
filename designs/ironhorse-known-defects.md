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

6 open, 6 of them P1.

- `F171` **P1** Keep recursive bound calls in the iterative dispatcher
- `F172` **P1** Fold long bound chains without Rust recursion
- `F173` **P1** Charge both newly enabled bound-apply forwarding paths
- `F174` **P1** Exclude arguments objects from the dense collection fast path
- `F175` **P1** Revalidate iterator hooks after the observable adder lookup
- `F176` **P1** Migrate or reject pre-collection-iterable snapshots

### arguments MOP, Error construction, global environment

14 open, 13 of them P1.

- `F177` **P1** Read arguments-object length through the property MOP
- `F178` **P1** Meter generic CreateListFromArrayLike reads in apply
- `F179` **P1** Dereference mapped arguments in the dense apply shortcuts
- `F180` **P1** Exclude arguments objects from AggregateError's dense shortcut
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
