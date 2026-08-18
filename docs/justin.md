---
title: justin
group: Documents
category: Reference
---

# Justin: the safe-expression subset that expresses `pass-style`

*Justin* is one rung of a nested family of JavaScript subsets — larger than
JSON, smaller than Jessie. It is the expression-only notation that
`@endo/marshal` uses to render any *passable*
value (anything `@endo/pass-style`'s `passStyleOf` accepts) as a human-readable
JavaScript expression. This document defines Justin, reconciles its grammar
against the renderer that actually ships in this repository, and maps each
`pass-style` category to the Justin form that expresses it.

This is a *reference* document. It is also the working record for locking down
**the exact Justin dialect that expresses `endo/pass-style`**. Where the
upstream grammar and the shipped renderer disagree, the disagreement is named
explicitly in [§ Divergences](#divergences-grammar-vs-implementation) rather
than silently resolved, because choosing between them is the point of the
review that accompanies this document.

## Where Justin sits

Justin is one rung of a containment ladder. Each level is a syntactic subset of
the next:

```
JSON  ⊂  Justin  ⊂  Jessie  ⊂  JavaScript
```

- **JSON** is pure data: object and array literals, strings, finite decimal
  numbers, `true`, `false`, `null`. No comments, no `undefined`, no
  expressions.
- **Justin** extends JSON with the rest of JavaScript's *pure expression*
  syntax (operators, member access, function *calls*, template literals,
  comments, `undefined`, unquoted property names) while still admitting **no
  statements and no definitions**. Justin is [defined by Jessie](#the-grammar)
  as *"the safe JavaScript expression language, a potentially pure terminating
  superset of JSON and subset of Jessie."*
- **Jessie** extends Justin back up to a full (but ocap-safe, `harden`-oriented)
  programming language: `const`/`let`, arrow functions, destructuring,
  statements, control flow, modules, assignment, computed property and member
  access.
- **JavaScript** is the unrestricted language Jessie is carved out of.

Each `⊂` is real syntactic containment. Every valid Justin expression is a valid
Jessie expression, and every valid Jessie program is valid JavaScript. The
reverse never holds.

### "Expression-only", exactly

Justin's top-level production parses **a single expression** and nothing else
(the grammar's `start <- _WS assignExpr _EOF`). Concretely, "expression-only"
excludes, relative to Jessie and JavaScript:

- **No statements**: no `if`/`else`, `while`, `for`, `switch`, `try`/`catch`,
  blocks `{ … }` as statements, labels, `return`, `throw`, `break`,
  `continue`, `debugger`. These keywords are *reserved* (kept out of the
  identifier space) purely so they cannot be misread as variable names.
- **No definitions**: no `function`, no arrow functions, no `class`, no
  `const`/`let`/`var`, no destructuring binding patterns.
- **No assignment or mutation**: `assignExpr <- condExpr`. Assignment
  (`=`, `+=`, …) and the increment/decrement operators (`++`, `--`) are absent,
  as is `delete`. There is therefore no way to write a side effect.
- **No `new`, `super`, `this`, `instanceof`, `in`, `yield`, `with`.**
- **No comma-sequence operator** (`expr <- assignExpr`).

What Justin *does* keep from JavaScript is the pure-expression core: unary and
binary operators, `?:`, `&&`/`||`, member access (`.name` and numeric
indexing), **function calls**, template literals, and **free-variable
references**. Justin is not closed data. A Justin
expression may name variables it does not bind and call functions it does not
define, so its meaning (and its purity and termination) depend entirely on the
*endowments* supplied for those free names by whatever evaluates it. See
[§ The evaluation story](#the-evaluation-story).

## The grammar

Justin is not defined in this repository. It is defined by the **Jessie**
project (the reference implementation of the Jessie/Justin subset languages),
as a bootstrapped PEG grammar that extends a JSON grammar and is in turn
extended by the Jessie grammar.

> **Source, and why the revision matters.** The grammar lives at
> [`endojs/Jessie`](https://github.com/endojs/Jessie/tree/main/packages/parse),
> file `packages/parse/src/quasi-justin.js` (Justin), extending
> `quasi-json.js` (the JSON base) and extended by `quasi-jessie.js.ts` (Jessie).
> This is `endojs`'s own actively-maintained copy of the grammar; the older
> [`agoric-labs/jessica`](https://github.com/agoric-labs/jessica)
> (`lib/quasi-justin.js` / `lib/quasi-json.js` / `lib/quasi-jessie.js`) is the
> ancestral reference and has been frozen since 2021 — this document originally
> read from it, then moved to the Jessie copy at
> [dckc's suggestion](https://github.com/endojs/endo-but-for-bots/pull/972#issuecomment-5280941723).
> The grammar is **not** versioned in this repository and will drift
> independently, so this document pins the exact revision it was read from:
> **`481af9f50d08eb11e1f4eea13bd816556ab3b1ba`** (2025-08-25, a repo-wide
> `chore: make prettier` pass). The Justin grammar's own last **substantive**
> touches are `3fe1ab2ea` (*"feat(parse): add bigint literals to justin"*) and
> `77855d53a` (*"feat(parse): permit number and bigint underscore separators"*),
> both 2025-03-13 — the two changes that carried Justin past the frozen jessica
> text (see [§ D3](#d3-bigint-literals-are-in-the-grammar)). When reconciling in
> future, diff against `packages/parse/src/quasi-justin.js` at the pinned commit
> specifically.

### What Justin adds to JSON

Reading the Jessie productions, Justin adds to JSON:

- **`undefined`** as a primary data structure.
- **BigInt literals** (`123n`): `bigintLiteral <- < int > "n"`, a data structure
  alongside `undefined`. (This is the material advance of the maintained Jessie
  grammar over the frozen jessica text, which had no bigint — see
  [§ D3](#d3-bigint-literals-are-in-the-grammar).)
- **Underscore digit separators** in both numbers and bigints (`1_000`,
  `1_000_000n`), stripped to their unseparated value. The renderer never *emits*
  a separator, so this is grammar-admits-more, not a renderer divergence.
- **Comments**: `//` line and `/* … */` block.
- **Single-quoted strings** in addition to JSON's double-quoted (normalized to
  double-quoted).
- **Unquoted property names**: a property name may be an identifier
  (`IDENT_NAME`) or a `NUMBER`, not only a quoted string. There are **no
  computed property names** (the grammar comments this explicitly:
  `# No computed property name`).
- **Trailing commas**, **array/object spread** (`...x`), and **shorthand
  properties**.
- **Template / quasi literals**, including the tagged-template member operation.
- **Free-variable use** (`useVar <- IDENT`) and **function calls**
  (`args → ['call', …]`). Note there is **no `new`**: Justin does not
  distinguish member-expressions from call-expressions because it has neither
  `new` nor `super`.
- **Member access**: `.name` and `[indexExpr]`, where (a non-JavaScript
  restriction) `indexExpr` admits **only a number** (or `+`-prefixed unary),
  never an arbitrary string or computed index.
- **Operators**: unary `void`/`typeof`/`+`/`-`/`~`/`!` (but **no** `++`/`--`,
  **no** `delete`); `**`; `* / %`; `+ -`; shifts `<< >> >>>`; a single
  non-associating "eager" tier bundling relational (`<= < >= >`), *strict*
  equality (`=== !==` only, **no** `==`/`!=`), and bitwise (`& ^ |`) so that
  mixing them requires parentheses; `&&`; `||`; and the ternary `?:`.
- **Identifier hardening**: `async`, `arguments`, `eval`, `get`, `set` are
  excluded from identifiers; the `$h_` and `$i_` prefixes are reserved; and
  `__proto__` is forbidden as an identifier property name.

The last point interacts with the shipped renderer in a way that matters a
great deal for `pass-style`; see
[§ Divergences](#divergences-grammar-vs-implementation).

## The renderer that ships here

The **authoritative definition of the Justin this repository actually emits**
is not the grammar above but the code in:

- `packages/marshal/src/marshal-justin.js`: `decodeToJustin`, the renderer,
  plus `passableAsJustin` and `qp`.
- `packages/marshal/test/marshal-justin.test.js` and its fixtures in
  `packages/marshal/tools/marshal-test-data.js` (`jsonJustinPairs`): the
  round-trip corpus that pins the exact output for every category.

The renderer does not consume a passable directly. It consumes marshal's
**capdata encoding**, the `{ "@qclass": … }`-tagged JSON tree that
`makeMarshal(...).toCapData` produces, and rewrites that tree as a Justin
expression. `passableAsJustin(passable)` is the convenience wrapper that
marshals first and then decodes. `qp(passable)` wraps the result in backticks
for use as a quasi-quoted diagnostic (see
[§ The evaluation story](#the-evaluation-story)).

Because it renders from the capdata encoding, the renderer inherits every
normalization the encoder performs. The most consequential is that **`-0` is
collapsed to `0`** in the encoder (`encodeToCapData.js`, *"Pass through
everything else, replacing -0 with 0."*), so no Justin expression ever denotes
negative zero even though `pass-style` classifies `-0` as an ordinary
`number`.

## The pass-style correspondence

This is the point of the exercise: for each `pass-style` category (the values
`passStyleOf` accepts), what Justin expression expresses it? Each row below is
cross-checked against `packages/pass-style/src` and the fixtures in
`jsonJustinPairs`.

### Passable atoms

| pass-style | example value | Justin form | notes |
| --- | --- | --- | --- |
| `undefined` | `undefined` | `undefined` | the grammar's one added literal |
| `null` | `null` | `null` | JSON |
| `boolean` | `true` | `true` / `false` | JSON |
| `number` (finite) | `1` | `1` | JSON number literal |
| `number` `NaN` | `NaN` | `NaN` | bare free variable |
| `number` `Infinity` | `Infinity` | `Infinity` | bare free variable |
| `number` `-Infinity` | `-Infinity` | `-Infinity` | unary `-` on `Infinity` |
| `number` `-0` | `-0` | `0` | **not expressible**; encoder collapses `-0` to `0` |
| `bigint` | `4n` | `4n` | native bigint literal (in-grammar, [§ D3](#d3-bigint-literals-are-in-the-grammar)) |
| `string` | `"abc"` | `"abc"` | JSON string literal |
| `symbol` | `Symbol.for('foo')` | `passableSymbolForName("foo")` | a **call**, not a literal |
| `symbol` (well-known) | `Symbol.asyncIterator` | `passableSymbolForName("@@asyncIterator")` | see below |
| `byteArray` | immutable `ArrayBuffer` | *(cannot be marshalled)* | see [§ Cannot express](#what-justin-deliberately-cannot-express) |

Notes on the atoms:

- **`NaN`, `Infinity`, `-Infinity`** are not literals in the grammar. They
  render as the bare identifiers `NaN` and `Infinity` (with unary `-`), which
  Justin parses as **free-variable references** resolved from the evaluation
  environment's globals. The header comment in the grammar claims Justin
  *"includes all floating point values: NaN, Infinity, -Infinity"*, but it
  achieves that through free variables, not dedicated literals.
- **`-0`** is admitted by `pass-style` as a `number` (`passStyleOf.js` returns
  `typeof x` unfiltered, so `-0`, `NaN`, and the infinities all classify as
  `number`), but marshal normalizes `-0` to `0` before Justin ever sees it, so
  Justin cannot denote it.
- **Symbols** are the first surprise. `pass-style` admits exactly two kinds of
  symbol (`symbol.js`): **registered** symbols (`Symbol.for(name)`) and
  **well-known** symbols (the symbol-valued static properties of `Symbol`,
  such as `Symbol.iterator`). Well-known symbols are named with an `@@` prefix
  (`Symbol.asyncIterator` becomes `"@@asyncIterator"`); a registered symbol
  whose name *already* starts with `@@` is escaped with an extra `@@` (the
  "Hilbert Hotel" trick). The renderer emits **every** passable symbol as a
  call to the endowed function `passableSymbolForName("…")`, passing that
  encoded name. It never emits the `Symbol.asyncIterator` member form for a
  general symbol; see the
  [symbol divergence](#d2-well-known-symbols-render-as-calls-not-symbol-member-access).

### Copy containers

- **`copyArray`** renders as an **array literal**: `[1, 2]`, `[undefined]`, `[]`.
  `pass-style` guarantees a copyArray is a frozen, `Array.prototype`-inheriting,
  dense array of only index properties (`copyArray.js`,
  `doc/copyArray-guarantees.md`); the array literal expresses exactly that.
- **`copyRecord`** renders as an **object literal**: `{ foo: 1 }`,
  `{ a: 1, b: { c: 3 } }`. A `copyRecord` is a frozen,
  `Object.prototype`-inheriting object of only **string-named**, enumerable,
  data properties (`copyRecord.js`, `doc/copyRecord-guarantees.md`). The
  renderer emits a property name **unquoted** when it matches `/^[a-zA-Z]\w*$/`,
  and quoted otherwise (`{ "1weird": … }`). Key order is the record's own-key
  order, unsorted.
  - **The `__proto__` case is special and contentious.** JavaScript reads
    `{ __proto__: x }` as *setting the prototype*, not as an own property named
    `__proto__`. A `copyRecord` may legitimately have a genuine own key
    `"__proto__"` (creatable via `defineProperty`). To preserve it, the
    renderer emits a **computed key**: `{ ["__proto__"]: 8 }` (fixture:
    `{"__proto__":8}` renders as `{["__proto__"]:8}`). This is the sharpest
    grammar/implementation divergence; see
    [§ D1](#d1-the-__proto__-record-key-is-outside-the-justin-grammar).
- **`tagged`** renders as a **call** `makeTagged("tag", payload)`. A tagged
  record is a `{ [Symbol.toStringTag]: tag, payload }` shape (`tagged.js`,
  `makeTagged.js`) used as the extension point for higher copy types
  (`copySet`, `copyMap`, `copyBag`, patterns). `makeTagged` is an endowment.
  Example: `makeTagged("x", 8)`.

### References: `remotable` and `promise`, the interesting ones

`remotable` and `promise` are the two `PassableCap` categories. They are
**not data**. A remotable is a near or far object with identity and callable
methods; a promise stands for a future settlement. Neither can be *copied*.
`pass-style` marks them as pass-by-reference exit points at the leaves of an
otherwise pass-by-copy tree. Marshal represents each as a **slot**: an index
into a side array of live references, carried in the encoding as
`{ "@qclass": "slot", index, iface? }`.

In Justin, a slot renders as a **call** to an endowed resolver:

- `slot(0, "Alleged: for testing Justin")` when the index is beyond the
  supplied `slots` array (the reference is denoted purely by its index and, for
  a remotable, its interface string).
- `slotToVal("hello", "Alleged: for testing Justin")` when the renderer was
  given a `slots` array. It renders each concrete slot value through
  `slotToVal(...)` instead.
- A back-reference to an already-seen slot omits the iface:
  `slot(0)` / `slotToVal("s0")`.

Two consequences for round-tripping matter:

1. **A reference is denoted by its slot, never by its contents.** Justin
   carries the *index* (and, for remotables, the self-asserted **interface
   string**, which is always `"Remotable"` or a string beginning with
   `"Alleged: "` or `"DebugName: "`; the `"Alleged:"` prefix marks the
   interface as *claimed and unverified*, `remotable.js`). Reconstituting the
   live object requires the evaluator to supply a `slot`/`slotToVal` that maps
   the index back to a real capability. Absent that endowment, the Justin text
   conveys only *"a reference was here, with this alleged interface"*. The
   identity itself does not travel in the text.
2. **Justin cannot distinguish a remotable from a promise.** Marshal's capdata
   encoding uses the same `slot` qclass for both, and the decoder documents the
   restriction explicitly: *"The current encoding does not give the decoder
   enough info to distinguish whether a slot represents a promise or a
   remotable"* (`encodeToCapData.js`). Both therefore render as `slot(...)` or
   `slotToVal(...)`; a promise simply tends to carry no iface. The
   remotable-versus-promise distinction is **not** preserved by a Justin
   round-trip.

### `error`

An `error` renders as a **call to the error constructor by name, without
`new`**: `Error("")`, `ReferenceError("msg")`. `pass-style` constrains a
passable error's constructor to a fixed set (`Error`, `EvalError`,
`RangeError`, `ReferenceError`, `SyntaxError`, `TypeError`, `URIError`, and
`AggregateError` where available; `error.js`, `getErrorConstructor`) and
recognizes the own properties `message` (required, string), `stack` (string),
`cause` (a passable error), and `errors` (a copyArray of passable errors).

The renderer expresses **only `name` and `message`**. It explicitly refuses the
rest:

- `cause` triggers `Fail`error cause not yet implemented in marshal-justin``
- `AggregateError` triggers `Fail`AggregateError not yet implemented in marshal-justin``
- `errors` triggers `Fail`error errors not yet implemented in marshal-justin``
- `stack` is silently dropped (never rendered).

So the Justin form of an error is **lossy** by construction. It captures the
constructor and message a human needs to read the diagnostic, and discards the
causal chain and stack. See
[§ D4](#d4-error-cause-aggregate-errors-and-stack-are-unrepresented).

## What Justin deliberately cannot express

Several of Justin's *inabilities* are the feature, not a gap. They are what let
a reader treat a Justin expression as data-like:

- **No function definitions.** A Justin expression cannot introduce new
  behavior; it can only *name* functions supplied to it. A reader who controls
  the endowments controls every function that can run.
- **No assignment, no `++`/`--`, no `delete`, no statements.** A Justin
  expression has no way to mutate a binding, an object, or the environment. It
  is *evaluated for its value*, not for effects.
- **No `new`.** It cannot construct via `[[Construct]]`; the error and symbol
  forms are plain calls precisely because construction is unavailable.

Taken together, a Justin expression's only powers are to build pass-by-copy data
and to *call the free variables it was handed*. If those endowments are pure and
terminating, so is the whole expression. That is the safety argument for using
Justin as a notation.

Two categories cannot currently be expressed at all, for implementation reasons
rather than by design:

- **`byteArray`** (immutable `ArrayBuffer`, `byteArray.js`) is a real
  `pass-style` category, but marshal's capdata *and* smallcaps encoders both
  throw *"marsal of byteArray not yet implemented"* before any Justin is
  produced. A `byteArray` therefore has **no Justin form today**, not because
  Justin's syntax lacks one, but because the value never survives marshalling.
- **Error `cause`, aggregate `errors`, and `stack`**, as above.

## The evaluation story

Justin is a **notation**, and in this codebase it is, in production, a
*write-only* one. `passableAsJustin`/`qp` are used to build **human-readable
diagnostic strings**. `qp` ("quote passable") renders a passable as a
backtick-quoted Justin expression for embedding in error messages, and is used
throughout `@endo/patterns` (`patternMatchers.js`) to report mismatches. **No
production code path evaluates Justin.** There is no `evaluate` of Justin
anywhere under any package `src/`.

Justin *is* evaluated in exactly one place: the round-trip **test**
(`marshal-justin.test.js`), which evaluates each rendered expression inside a
`Compartment` and re-marshals the result to prove the text round-trips back to
the original encoding. That test is therefore also the **specification of the
evaluation environment** a Justin evaluator must provide. The compartment
endows:

- `slot`, `slotToVal`: resolve a slot index/value to a live remotable/promise.
- `makeTagged`: reconstruct a tagged record.
- `passableSymbolForName`: reconstruct a passable symbol from its encoded name.

and relies on the compartment's own globals for `Symbol` (unused by the general
path today), the error constructors (`Error`, `TypeError`, …), `NaN`,
`Infinity`, `undefined`, and native bigint literal syntax.

### The capability question

Because Justin's meaning is supplied by its endowments, **evaluating Justin is a
capability decision, not a parsing detail.** The most expressive endowments are
`slot`/`slotToVal`. A resolver that maps a slot back to a *real* capability
grants the evaluated expression live authority: the very remotables and
promises the reference denoted. An evaluator that wants only data
reconstruction must either omit slot resolvers (so any reference-bearing
expression fails loudly) or supply inert stand-ins.

The `makeTagged` and `passableSymbolForName` endowments are comparatively
benign (pure constructors of inert data), but they are still *authority the
evaluator chose to grant*. The safe reading of a Justin expression as data holds
**only** for expressions that contain no slots, and only when the endowments are
themselves pure. Any actor who can both (a) choose the endowments and (b) feed
in expression text controls what runs. Treating attacker-influenced Justin text
as if it were inert data, and evaluating it with real slot resolvers, would be a
confused-deputy hazard. In this codebase that hazard does not arise, because the
only Justin that is ever evaluated is the test corpus, in a compartment the test
controls end to end.

## Divergences (grammar versus implementation)

These are the concrete disagreements between the Jessie grammar
([§ The grammar](#the-grammar)) and the shipped renderer
([§ The renderer](#the-renderer-that-ships-here)). **Each is an open question
for the review that locks the dialect**, not something this document resolves.
None is a code change: per the scope of the work that produced this document,
the renderer is left untouched and any implementation fix is a separate job.

### D1. The `__proto__` record key is *outside* the Justin grammar

The renderer emits `{ ["__proto__"]: 8 }`, a **computed property name**, to
express a `copyRecord` with a genuine own key `"__proto__"`. But the Jessie
grammar admits **no computed property names** at all (`# No computed property
name`), and separately forbids `__proto__` both as an identifier property name
(`IDENT_NAME <- ~(HIDDEN_PFX / "__proto__" _WSN) …`) and as a quoted one (the
JSON base's `propName` returns `FAIL` for `"__proto__"`, *"Don't allow
__proto__ behaviour attacks."*). So there is **no valid Justin spelling** of a
`__proto__`-keyed record, yet marshal supports exactly such records and the
renderer must emit *something*. What it emits (`["__proto__"]:`) is valid
**Jessie** and valid JavaScript, but **not** valid Justin.

*Decision needed:* does the locked Justin dialect admit computed property keys
(at least for the `__proto__` case), or does it forbid `__proto__`-keyed
`copyRecord`s from being rendered as Justin? This is the headline question.

### D2. Well-known symbols render as calls, not `Symbol.` member access

The grammar can express a well-known symbol as `Symbol.asyncIterator`
(member access on the free variable `Symbol`), and the renderer *contains* code
intended to do so: the branch that emits `Symbol.${suffix}` when
`registeredName === undefined`. But that branch is **unreachable**. For any
passable symbol, `passableSymbolForName(name)` yields a passable symbol and
`nameForPassableSymbol` of a passable symbol *always* returns a string
(well-known symbols map to their `@@`-name, `symbol.js`), so `registeredName` is
never `undefined`. Every symbol therefore renders as
`passableSymbolForName("…")`.

Compounding this, the **deprecated** dedicated `@@asyncIterator` qclass *does*
render as `Symbol.asyncIterator`, so the *same* symbol value renders two
different ways depending on which encoding it arrived in.

*Decision needed:* is the endowment-call form
(`passableSymbolForName("@@iterator")`) the intended, canonical Justin spelling
for all symbols (in which case the dead `Symbol.${suffix}` branch and the
deprecated `@@asyncIterator` special case are latent inconsistencies to clean up
in a separate job), or should well-known symbols render as `Symbol.iterator`
member access (fewer endowments, closer to the grammar)?

### D3. BigInt literals are in the grammar

*(Resolved by adopting the maintained Jessie source.)*

The renderer emits `4n`, `9007199254740993n`, native JavaScript **bigint
literals**. Against the *frozen* jessica grammar this was a divergence: that
grammar's `NUMBER` production is `< int frac? exp? >` with no `n` suffix, and its
header comment said only that Justin *"will include BigInt once available."*

That gap is **closed** in the actively-maintained Jessie grammar this document
now cites (the reason to prefer it). The pinned revision has a first-class
`bigintLiteral <- < int > "n" _WSN` production, admitted as a `dataStructure`
beside `undefined`, added in `3fe1ab2ea` (*"feat(parse): add bigint literals to
justin"*, 2025-03-13); its header comment now reads *"includes BigInt literals:
123n."* The shipped `4n` form is therefore **exactly in-grammar**, not ahead of
it. (The same source also added underscore digit separators, `1_000_000n`, in
`77855d53a` — a feature the grammar admits but the renderer never emits.)

*No decision needed:* recorded as resolved. `4n` is Justin under the pinned
grammar; the only thing the lock must confirm is the choice of the Jessie source
over the frozen jessica one, which is what moving this citation does.

### D4. Error `cause`, aggregate `errors`, and `stack` are unrepresented

`pass-style` recognizes `cause`, `errors` (for `AggregateError`), and `stack`
on a passable error, but the renderer throws on the first two and drops the
third ([§ error](#error)). The Justin form of an error is thus strictly less
expressive than the pass-style error it renders.

*Decision needed:* is the lossy `Name("message")` form the intended, permanent
Justin spelling of an error (diagnostics only), or should the dialect grow forms
for `cause`/`errors`/`stack`? If the latter, that is a separate implementation
job, not part of locking the notation.

### D5. `byteArray` has no Justin form

Not strictly a grammar/renderer divergence (the whole marshal path rejects
`byteArray`), but it means the pass-style category `byteArray` has **no** Justin
expression today. Recorded here so the dialect lock is explicit that `byteArray`
is out of scope until marshalling of it lands.

### Not divergences (grammatically fine, endowment-dependent)

For completeness, the following renderer outputs are **valid Justin** as
written, and are called out only because they rely on endowments rather than on
literals. `makeTagged("x", 8)`, `slot(0, "iface")`, `slotToVal("s0")`,
`passableSymbolForName("foo")`, and the error-constructor calls `Error("")` and
`ReferenceError("msg")` are all free-variable calls, which Justin's grammar
admits. Their reconciliation question is not *"is this Justin?"* but *"which
endowments must an evaluator provide?"*, answered in
[§ The evaluation story](#the-evaluation-story).

## Summary of open questions for the dialect lock

1. **D1** (headline): does locked Justin admit computed property keys
   (`["__proto__"]:`) for `copyRecord`s with a `__proto__` own key, or forbid
   rendering them?
2. **D2**: is `passableSymbolForName("…")` the canonical spelling for *all*
   passable symbols (retiring the dead `Symbol.` branch and the deprecated
   `@@asyncIterator` path), or should well-known symbols use `Symbol.` member
   access?
3. **D3** *(resolved)*: bigint literals (`4n`) are in the maintained Jessie
   grammar, so the shipped form is in-grammar; the lock need only ratify citing
   the Jessie source over the frozen jessica one.
4. **D4**: is the lossy `Name("message")` error form permanent, or should
   `cause`/`errors`/`stack` gain Justin forms (separate job)?
5. **D5**: `byteArray` is out of scope until marshalling of it is implemented.

## References

- Grammar: [`endojs/Jessie`](https://github.com/endojs/Jessie/tree/main/packages/parse),
  `packages/parse/src/quasi-justin.js` / `quasi-json.js` / `quasi-jessie.js.ts`
  at commit `481af9f50d08eb11e1f4eea13bd816556ab3b1ba` (2025-08-25); the
  substantive Justin changes past the ancestral grammar are `3fe1ab2ea` (bigint
  literals) and `77855d53a` (underscore separators), both 2025-03-13. Ancestral
  reference (frozen 2021): [`agoric-labs/jessica`](https://github.com/agoric-labs/jessica),
  `lib/quasi-justin.js` at commit `e8ab6f70065360e201d5230824796b1ce6557cb7`
  (2021-10-18).
- Renderer: `packages/marshal/src/marshal-justin.js`; fixtures
  `packages/marshal/tools/marshal-test-data.js` (`jsonJustinPairs`); test
  `packages/marshal/test/marshal-justin.test.js`.
- pass-style categories: `packages/pass-style/src` (notably `passStyleOf.js`,
  `symbol.js`, `remotable.js`, `safe-promise.js`, `error.js`, `copyArray.js`,
  `copyRecord.js`, `tagged.js`, `byteArray.js`) and
  `packages/pass-style/doc/{copyArray-guarantees,copyRecord-guarantees,enumerating-properties}.md`.
- Encoding normalizations: `packages/marshal/src/encodeToCapData.js`.
