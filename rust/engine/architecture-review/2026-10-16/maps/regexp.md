# Map: RegExp (compiler, matcher, VM natives)

Reviewed commit `61cd656cb`.

## Scope

Assigned files (line counts via `wc -l`):

- `rust/engine/ironhorse-regexp/src/lib.rs` — 627 (entry `run`, in-crate unit tests)
- `rust/engine/ironhorse-regexp/src/compile.rs` — 3543 (parser + measure + emit)
- `rust/engine/ironhorse-regexp/src/matcher.rs` — 859 (backtracking VM)
- `rust/engine/ironhorse-regexp/src/charcase.rs` — 2559 (case-fold tables + canonicalize)
- `rust/engine/ironhorse-regexp/src/encoding.rs` — 206 (CESU-8/UTF-8 codec)
- `rust/engine/ironhorse-regexp/src/flags.rs` — 24, `opcode.rs` — 38, `unicode.rs` — 6,
  `unicode_property.rs` — 17 (small glue)
- `rust/engine/ironhorse-regexp/src/unicode_properties_generated.rs` — 6296
  (structure/size only)
- `rust/engine/ironhorse-regexp/src/unicode_string_properties_generated.rs` — 5605
  (structure/size only)
- `rust/engine/ironhorse-regexp/src/compile/validation_tests.rs` — 140
- `rust/engine/ironhorse-regexp/tests/*` — 2630 (parity, golden, work_limits, 6 fuzz
  regressions, validation)
- `rust/engine/ironhorse-vm/src/interp/natives/regexp.rs` — 2630 (JS RegExp/String surface)
- plus the String/RegExp dispatch sites in
  `rust/engine/ironhorse-vm/src/interp/natives/dispatch.rs` and the implicit-getter arm in
  `rust/engine/ironhorse-vm/src/interp/dispatch/property_read.rs` (grep-driven)

## What was read

- **Full read**: `matcher.rs`, `encoding.rs`, `lib.rs`, `flags.rs`, `opcode.rs`,
  `unicode.rs`, `unicode_property.rs`; `compile.rs` (all passes: lexer, charset builders,
  v-mode class expression, quantifier, disjunction/group, measure, emit, helpers);
  `natives/regexp.rs` in full.
- **Targeted**: `charcase.rs` head/tail (`canonicalize`, `find_row`, `apply_row`,
  `for_each_unicode_fold_mapping`; table bodies skimmed for shape). `dispatch.rs` RegExp
  construction arm (~2000-2140), RegExp/String method dispatch (5940-6340, regexp_protocol
  6033-6100), `exec_regexp`/`exec_string` opcode arms. `property_read.rs` RegExp getter arm
  (195-250). `link.rs` getter/result id resolution (30-134). `interp.rs` RegExpData struct
  (1225), `regexp_flag_bit_for` (3535), RunOutcome. `intrinsic_order.rs` RegExp prototype
  key order (555-580). `side_ledger.rs` (retained-table accounting). `admission.rs`
  (scratch reservation). `boot.rs` RegExp prototype install.
- **Grep-driven**: callers of every `natives/regexp.rs` entry; `collect_garbage`;
  cross-crate unicode-table ownership; `ironhorse-xst` meter arming.
- **Probes**: JS probes under `../probes/regexp/` (p01–p34) against
  `target/release/ironhorse-xst` vs node22; 2 Rust integration probes (deleted) measuring
  program size, per-step backref cost, per-state allocation, the state ceiling, and
  computron-vs-walltime for global loops.

## What was not read

- `unicode_properties_generated.rs` / `unicode_string_properties_generated.rs` row by row
  (examined structure, representation, and size only, per brief). The `lookup_*` match arms
  were read; the endpoint arrays were measured, not audited for Unicode correctness against
  a UCD reference.
- `charcase.rs` fold-table rows (IGNORE0/FOLD0/FOLD1) individually — I read the row format,
  `find_row`/`apply_row`/`canonicalize`, and the fold-enumeration helper, but did not verify
  each run against the pin.
- `tests/parity.rs` (650 lines) and `compile_golden.rs` read for intent, not line by line.
- The snapshot/persist codec for `RegExpData` (another region owns snapshot); I noted only
  that `source`+`flags` are persisted and recompiled on restore.
- `charcase.rs` is 2559 lines and ~95% table data; not transcribed.

## Architecture as built

**Three stages, one crate, engine-internal (no JS surface).** `ironhorse-regexp` is
`#![forbid(unsafe_code)]` and ports XS `xsre.c`. `compile()` parses the pattern into a
`Vec<Node>` term tree on explicit work-stacks (never native recursion — `disjunction_parse`
compile.rs:2257, `charset_expression` :1877, `measure` :2649, `emit` :2798 each run a
`Vec<…Work>` loop), runs a `measure` pass assigning each term a **byte** offset into the
code array (`size += mx*StepSize`), then an `emit` pass writing the integer step stream.
The output `Program { code: Vec<i32>, capture_count, name_count, assertion_count,
quantifier_count, compile_meter_raw, capture_group_names }` (compile.rs:48). `code[0]` is
the flags word, `code[1..=4]` the four counts, `code[5..5+name_count]` the name slots,
then the emitted steps; `code[b/4]` is the word at byte `b`.

**Matcher** (`match_regexp_budgeted`, matcher.rs:207) interprets the step stream with an
explicit `Vec<State>` backtrack stack. A `State` is `{ step, offset, flags, captures:
Vec<(i32,i32)> }`, charged a flat `STATE_CHARGE = 40` bytes plus the captures slice
(matcher.rs:134); assertions/quantifiers use side vectors indexed by assertion/quantifier
index. `fxPopStates(from,to)` becomes `states.truncate(marker)`. Every dispatched step
charges `meter += XS_REGEXP_METERING` (= `1<<16`, i.e. one computron/step) and decrements
`work_budget`; with a `check` callback it consults every `MATCH_CHECK_STRIDE = 1024` steps
(matcher.rs:288-303). Backtrack storage is bounded by `MAX_MATCH_STATES = 65_536` and
`MAX_MATCH_BYTES = 64 MiB` (matcher.rs:127-128); exceeding either sets `resource_limit`.

**Encoding.** Subjects reach the matcher as XS CESU-8 bytes with a code-unit→byte offset
map (`regexp_subject_bytes`, natives/regexp.rs:1010). The codec (`encoding.rs`) decodes one
UTF-16 code unit normally and combines a valid surrogate pair only under `u`/`v`
(`find_character`, `get_character`). Under `i`, `get_character` folds the decoded point via
`charcase::canonicalize(c, unicode)`: `fold=false` uses the upper-ward BMP-only `IGNORE0`
table, `fold=true` uses lower-ward `FOLD0`+astral `FOLD1`.

**VM surface** (`natives/regexp.rs`). `build_regexp` compiles via
`compile_units_checked`, charges compile + code-buffer + data-buffer work, stores
`RegExpData { program, source: Vec<u16>, flags: String, last_index }` in a `regexps` side
table keyed by `SlotIndex`, installs `lastIndex`. Matching drives through
`match_regexp_metered` (natives/regexp.rs:519), which charges the match meter
incrementally when a host meter is armed and all-at-once otherwise. The eight RegExp
accessor getters (`source`/`flags`/`global`/…) are **not** real properties: they are
special-cased by program-local symbol id in the `GET_PROPERTY` opcode arm
(`property_read.rs:214-250`, ids from `regexp_getter_ids`), and the exec-result own
properties `index`/`input`/`groups`/`indices` are created only when their id resolved
(`regexp_result_ids`, link.rs:57). Protocol methods (`@@match/@@replace/@@split/@@search/
@@matchAll`) have a generic MOP path and a fast path (`regexp_replace_fast_safe`,
natives/regexp.rs:222) taken when no accessor/exec override and no Proxy intervene.

**Spec coverage is wide.** Ported and executing: `u` core (astral whole-unit, `\u{}`,
lower-ward fold incl. astral, unicode backrefs), `v` set notation (`--`/`&&`/nested
classes/`\q{}` string sets/string properties), `d` indices, named groups incl. duplicate
names across alternatives, lookbehind, inline modifiers `(?ims-ims:…)`, `\p{}`/`\P{}` in
every mode, `RegExp.escape`, sticky/global/`lastIndex`, `@@*` protocol with subclassing and
SpeciesConstructor. The crate deliberately matches XS's *stricter-than-AnnexB* verdicts
(no legacy octal, no quantified assertions, no `\c` fallback) — these are intended
departures locked by in-crate tests, not bugs.

## Candidate findings

### RGX-1 — Benign long matches (and `*`/`+` over long runs) abort the whole machine with an uncatchable `HeapExhausted`

- **Lens(es)**: 1 (resource bound reachable from guest input; metering/ceiling), 5 (test262).
- **Proposed severity**: high.
- **Location**: `matcher.rs:127` (`MAX_MATCH_STATES = 65_536`), the state-push sites
  `matcher.rs:336,560,644,683` (`SaveStop::Limit → resource_limit`), surfaced as
  `Halt::HeapExhausted` at `natives/regexp.rs:556`.
- **Excerpt**: `pub const MAX_MATCH_STATES: usize = 65_536;` … `Err(SaveStop::Limit) => {
  resource_limit = true; break 'scan; }`; and `if outcome.resource_limit { return
  Err(Step::Host(Halt::HeapExhausted)); }`.
- **Mechanism**: An unbounded greedy quantifier saves one backtrack `State` per matched
  position (`CX_QUANTIFIER_GREEDY_LOOP` pushes whenever `min==0`, which becomes true after
  the first iteration for `+` too). At 65 536 retained states the matcher sets
  `resource_limit`, which the VM converts to `Halt::HeapExhausted` — a host halt that guest
  `try/catch` cannot intercept.
- **Scenario**: Trimming trailing whitespace from a ~100 KB string — `"x".repeat(100000)
  .replace(/x+$/,"")` — or `/^(.*)$/.exec(longLine)`, or `/a*/.exec(s)` with `s` longer
  than 65 535 chars, halts the entire machine. Node returns in microseconds. The threshold
  is exactly `MAX_MATCH_STATES` (`/a*/` fails at 65 536, passes at 65 535; the 2-state-per-
  char `(?:a|b)*` caps at 32 767).
- **Evidence** (probe, confirmed):
  - p04 bisect: `/a*/.exec("a".repeat(n))` → `n=65535` Error:65535; `n=65536`
    `InternalError: ironhorse halted: HeapExhausted`.
  - p33: `"x".repeat(100000).replace(/x+$/,"").length` → IH `HeapExhausted`; node `0`.
  - p32: wrapping `/a*/.exec("a".repeat(100000))` in `try/catch` still exits 1 with
    `HeapExhausted` — **uncatchable**.
  - Rust probe CEILING: `(?:a|b)*` longest matched run = 32767.
  - This is the `skip:ironhorse-aborted-limit` class in test262 (see RGX-6):
    `built-ins/RegExp/property-escapes/generated/*` (≈680 case/mode skips),
    `built-ins/RegExp/CharacterClassEscapes/*-positive-cases.js`,
    `built-ins/RegExp/quantifier-integer-limit.js` all abort here.
- **Recommendation**: The deterministic ceiling is defensible, but (a) it is far lower than
  real subjects need and (b) converting a *successful* match that merely retained many
  states into an uncatchable machine halt is the wrong failure mode. A greedy
  quantifier whose body is a single char-set needs no per-position backtrack state at all
  (XS and other engines special-case it); even failing that, surface the limit as a
  catchable `RangeError`-shaped throw (as stack overflow / meter abort already map to
  `RangeError`) rather than `HeapExhausted`, so guests can recover.
- **Confidence**: confirmed by probe.

### RGX-2 — RegExp.prototype flag/source/flags accessors are not real properties: missing own keys, no descriptors, getter not extractable, `delete` not honored, computed-key reads return undefined

- **Lens(es)**: 1 (guest-visible wrong results), 6 (ontology: an accessor concept modeled
  as an id-match special case rather than a property), 5 (test262).
- **Proposed severity**: high.
- **Location**: `property_read.rs:214-250` (implicit getter arm keyed on
  `regexp_getter_ids`), `link.rs:45-56` + `:120-129` (ids resolved only from the program
  symbol table), `boot.rs:1427-1443` (prototype installs only `exec/test/toString/compile`,
  no accessors), `intrinsic_order.rs:570-581` (the accessor names are listed for key order
  but never materialized as own slots).
- **Excerpt**: `property_read.rs`: `let g = self.regexp_getter_ids; if Some(id) == g.source
  { … } else if let Some(bit) = regexp_flag_bit_for(g, id) { … } else { self.mop_get(…) }`.
- **Mechanism**: The accessors exist only as a dispatch special case triggered when the
  looked-up property id equals a getter id resolved at link time **from identifiers in the
  compiler symbol table**. A name reached only through a computed/bracket key or a string
  literal has a different (or absent) id, so the special case is skipped and the lookup
  falls through to an ordinary (empty) property walk. The prototype carries no own accessor
  slots, so reflection cannot see them.
- **Scenario**: Guest-observable divergences from spec/Node:
  - `Object.getOwnPropertyNames(RegExp.prototype)` is
    `compile,constructor,exec,test,toString` — missing all 10 accessor names (p12).
  - `Object.getOwnPropertyDescriptor(RegExp.prototype,'global')` → `undefined` (should be an
    accessor descriptor); so the `flags`/`global`/… getter **cannot be extracted** and
    `.call`-ed on another object. This fails the entire `built-ins/RegExp/prototype/{flags,
    global,source,ignoreCase,multiline,sticky,unicode,hasIndices,dotAll,unicodeSets}`
    coercion suites (RGX-6).
  - `r["global"]`, `r["source"]`, `r["flags"]`, `r[k]` all return `undefined` when the name
    is not spelled as a static identifier anywhere in the program (p27: all `null`/undefined;
    p28: `r.global`→true but `r["global"]`→undefined in the same program).
  - `delete RegExp.prototype.global` returns true, then `/a/g.global` still returns `true`
    (p12 `[true,true]`; Node `[true,null]`) — deletion silently ineffective.
- **Evidence** (probe, confirmed): p12, p27, p28 above; test262 `prototype/flags@@0000`
  shows `fail:"ironhorse ...` on 28 case/modes, `global` 18, `multiline`/`ignoreCase` 18
  each, `source`/`sticky`/`hasIndices`/`dotAll`/`unicode` 12 each, with messages
  `ironhorse threw where the oracle completed: TypeError: cannot coerce undefined to object`
  (the extracted-getter-called-generically path) and `error-message-differs:TypeError`.
- **Recommendation**: Reify the ten accessors as genuine accessor own-properties on
  `%RegExp.prototype%` (getter functions backed by the side table), as Node/XS do. That
  fixes own-key enumeration, descriptors, `getter.call(x)`, computed-key reads, and
  deletion uniformly, and removes the dependence on how the guest spelled the name.
- **Confidence**: confirmed by probe.

### RGX-3 — exec/match result own properties `index`/`input`/`groups`/`indices` are created only when the program statically spells the identifier

- **Lens(es)**: 1 (guest-visible wrong results), 6 (ontology: result-property identity tied
  to lexical identifier use), 5 (test262).
- **Proposed severity**: high.
- **Location**: `natives/regexp.rs:1100-1156` (each result property installed only `if let
  Some(id) = self.regexp_result_ids.{index,input,groups,indices}`), resolved at
  `link.rs:57-61`/`:130-133` from the symbol table. Same root mechanism as RGX-2.
- **Excerpt**: `self.meter.tick_slot_alloc(); // index  if let Some(id) =
  self.regexp_result_ids.index { self.instance_put_raw(result, id, Slot::integer(
  match_start)); }` — when `regexp_result_ids.index` is `None`, the property is simply never
  created.
- **Mechanism**: `regexp_result_ids` is `None` for any of the four names not present as a
  static identifier in the program, so `exec`/`match` return an array lacking those own
  properties. A program that reads `m.index` (dot, an identifier) resolves the id and the
  property appears; the same program reading only `m["index"]` (string literal) does not.
- **Scenario**:
  - `JSON.stringify(/(?<y>a)/.exec("a"))` differs by whether `index`/`groups` were spelled.
  - `Object.keys(/a/.exec("xa"))` → `["0","index"]` vs Node `["0","index","input","groups"]`
    (p24); `{...match}` and `Object.assign({}, match)` drop the standard properties.
  - `const m=/a/.exec("xa"); m["index"]` → `undefined` (p25) unless `.index` is spelled
    elsewhere (p29/p30 show spelling `.index` anywhere in the program makes `m["index"]`
    return `1` and the key present — direct proof of the id-resolution dependence).
  - `/a(b)?/d.exec("a").indices` is missing its own `groups` key (p23, and the test262
    failure `match-indices/indices-groups-object-undefined.js`:
    `Test262Error: groups should be an own property`).
- **Evidence** (probe, confirmed): p21–p31; test262 `built-ins/RegExp/match-indices@@0000`
  `fail:"ironhorse ... groups should be an own property"`.
- **Recommendation**: Always intern the four result-property keys at RegExp-surface init
  (as the generic `@@replace` path already force-interns `index`/`groups`, natives/
  regexp.rs:1603-1610) and always create the properties per `RegExpBuiltinExec`, independent
  of program text.
- **Confidence**: confirmed by probe.

### RGX-4 — `\p{…}` unicode case-fold over a wide range (and large-range `[a-b]` under `iu`) is O(range) at compile time; `RGI_Emoji` compiles to a ~258 KB program and a retained-RegExp heap bomb

- **Lens(es)**: 4 (performance / memory), 1 (metering: compile work is charged but the
  product is a per-instance 258 KB buffer that outlives the charge).
- **Proposed severity**: medium.
- **Location**: `compile.rs:1261-1299` (`charset_unicode_fold_targets` iterates **every**
  Unicode fold mapping, plane 1-16), `compile.rs:1422-1460` (`charset_range` under `i`
  canonicalizes every code point in `[begin,end]`), and the string-property lowering
  `compile.rs:2090-2127` (`charset_strings_disjunction` turns each `\q{}`/string-property
  alternative into a disjunction/sequence subtree). `RGI_Emoji` has thousands of string
  alternatives.
- **Excerpt**: `charset_unicode_fold_targets`: `crate::charcase::for_each_unicode_fold_
  mapping(|source, target| { if charset_contains(property, source) == include_members {
  targets.push(target); } });` — a full fold-table sweep per folded property.
- **Mechanism**: `[\0-\u{10FFFF}]` under `iu` folds 1.1M code points one at a time
  (417 824 compile computrons, 137 ms — p "PROGRAM" probe). `\p{RGI_Emoji}` under `v`
  lowers its ~1 300 multi-scalar emoji sequences into a giant disjunction: a single
  `/\p{RGI_Emoji}/v` compiles to **257 716 bytes** of `code`. Each retained instance keeps
  that buffer.
- **Scenario**: `for (let i=0;i<2000;i++) keep.push(new RegExp("\\p{RGI_Emoji}","v"))` holds
  2 000 × ~258 KB ≈ 500 MB and takes 13.7 s (p14, measured maxrss 502 MB vs 10.8 MB for the
  same loop with `/a/v`). Under a quantifier, `^\p{RGI_Emoji}+$` costs ~5 660 match steps
  per emoji matched (RGI_PLUS probe). Compile work *is* metered, but the 258 KB is a live
  per-instance cost the one-time compile charge does not recur for.
- **Evidence** (Rust probe, confirmed): PROGRAM/RGI_PLUS lines; p14 RSS measurement.
- **Recommendation**: (a) Represent finite string-set alternatives as a dedicated matcher
  structure (a trie or a sorted list the matcher walks) rather than lowering to a disjunction
  subtree, so the program is linear in the alphabet rather than in the expansion. (b) For
  whole-range folds, intersect the property with the fold table's domain instead of sweeping
  all 1.1M scalars. (c) If a per-instance 258 KB program is unavoidable, consider interning /
  sharing identical compiled programs across RegExp instances with the same source+flags.
- **Confidence**: confirmed by probe.

### RGX-5 — Global String/RegExp loops re-encode and re-scan the whole subject per match (O(n·matches))

- **Lens(es)**: 4 (performance).
- **Proposed severity**: medium.
- **Location**: `natives/regexp.rs:1041-1053` (`regexp_exec_inner` calls
  `regexp_subject_bytes` on the full subject every call), driven per-match by
  `regexp_match` (:644 loop), `regexp_replace_generic` (:1624 loop), `string_replace`
  (:1492 loop), `regexp_split` (:787 loop), `regexp_string_iterator_next` (:946, which
  re-`new_string_units` the subject each `next()`).
- **Excerpt**: `regexp_exec_inner`: `let (subject, offsets) =
  self.regexp_subject_bytes(&subject_units)?;` on every exec; the global drivers call exec
  once per match.
- **Mechanism**: Each exec rebuilds the CESU-8 byte buffer + offset map for the *entire*
  subject (`regexp_subject_bytes` allocates `len*3` bytes + `len+1` offsets) and then scans
  from `lastIndex`. A global match/replace/split with `m` matches over an `n`-unit subject is
  O(n·m) in encoding + O(n·m) in scanning, where real engines keep one encoded subject and
  resume. matchAll additionally stores the subject as UTF-16BE in the iterator and re-decodes
  it every `next()`.
- **Scenario**: measured super-linear growth (VM probe, computrons are linear but wall time
  is not; ironhorse-xst wall time): `"ab".repeat(n).match(/a/g)` 3.4 s at n=16000 vs node
  0.09 s; `"a,".repeat(n).split(/,/)` 8.9 s at n=16000 vs node 0.16 s; `replace(/a/g,…)`
  3.76 s vs 0.10 s. `"ab".repeat(16000).matchAll(/a/g)` additionally hits
  `HeapExhausted` (p07) — the per-`next` re-encode compounds with RGX-1.
- **Evidence** (probe, confirmed): p05–p08 timings; VM probe `match_g`/`split_re`
  ns_per_computron rising ~2× as n doubles (the computron count is linear, so the rising
  ns/computron is the unmetered re-encode/re-scan).
- **Recommendation**: Encode the subject once per global operation and resume the matcher
  from a byte offset, sharing the offset map across iterations; for matchAll, keep the
  encoded subject in the iterator state rather than re-decoding per `next()`.
- **Confidence**: confirmed by probe.

### RGX-6 — Unbounded greedy backtracking is not self-limited in an unarmed host (xst and any embedding that does not arm a meter)

- **Lens(es)**: 1 (metering — work is metered but the bound is only enforced when a host
  arms the meter).
- **Proposed severity**: medium.
- **Location**: `natives/regexp.rs:519-563` (`match_regexp_metered`): the `None if
  !meter.is_armed() => { meter.tick_raw(delta); true }` arm never interrupts; `ironhorse-262/
  src/lib.rs:58` (`interp_with_source_bridge` never calls `arm_meter`).
- **Excerpt**: `None if !meter.is_armed() => { meter.tick_raw(delta); true }` — the callback
  always returns `true`, so `match_regexp_budgeted` runs to completion.
- **Mechanism**: The matcher charges and exposes incremental work (every 1024 steps via the
  callback), so an *armed* host bounds `/(a+)+$/` by `Halt::MeterAbort`. But the default
  `Interp` and the conformance host arm no meter, so catastrophic backtracking runs to
  completion — exponential.
- **Scenario**: `/(a+)+$/.test("a".repeat(100)+"!")` does not return within 120 s in
  `ironhorse-xst` (p34, killed). In a consensus deployment with an armed meter + finite
  ceiling this becomes a bounded `MeterAbort`; the risk is specific to unarmed embeddings.
- **Evidence**: p34 (hang, killed); code path in `match_regexp_metered`.
- **Recommendation**: This is primarily a host-configuration caveat; documenting that the
  RegExp matcher is only DoS-safe under an armed meter would prevent an embedder shipping an
  unarmed `Interp` as a sandbox. Optionally give the matcher a default finite
  `work_budget` even when unarmed.
- **Confidence**: confirmed by probe (bounded reasoning for the armed case).

### RGX-7 — Three independent `GetSubstitution` implementations and two binary-range-membership searches

- **Lens(es)**: 2 (duplication), 6 (one spec operation with three code identities).
- **Proposed severity**: low.
- **Location**: `GetSubstitution`: `string_plain_substitution` (natives/regexp.rs:1273),
  `regexp_generic_substitution` (:1750), `regexp_get_substitution` (:1920). Range membership:
  `match_character` (matcher.rs:102) and `charset_contains` (compile.rs:3366) are the same
  half-open-range binary search; `find_row` (charcase.rs:2475) a third variant over
  `(code,count)` runs.
- **Mechanism**: The three substitution routines each re-scan `$`-tokens (`$$`, `$&`,
  `` $` ``, `$'`, `$n`/`$nn`, `$<name>`) with subtly different capture-source plumbing
  (search text vs match-array vs coerced generic captures). They are easy to drift: e.g.
  `string_plain_substitution` has no `$n`/`$<name>` arm at all (it serves literal-string
  search, which has no captures), which is correct but makes "which `$`-rules apply" a
  per-site answer.
- **Scenario**: maintenance hazard; a spec fix to `$`-token handling must land in three
  places. No divergence observed between the three in probing.
- **Recommendation**: Factor one `GetSubstitution` over a small capture-source trait
  (whole/numbered/named lookups); share one `range_contains(sorted_ranges, c)` between the
  matcher and compiler.
- **Confidence**: high (static).

## Duplication inventory

| Family | Copies (path:line) | Size / notes |
|---|---|---|
| `GetSubstitution` `$`-token expansion | `natives/regexp.rs:1273`, `:1750`, `:1920` | 3 copies, ~50-90 lines each |
| Sorted half-open range membership (binary search) | `matcher.rs:102` `match_character`, `compile.rs:3366` `charset_contains` | 2 copies, same algorithm; `charcase.rs:2475` `find_row` a related `(code,count)` variant |
| Flag-letter ↔ bit mapping | `compile.rs:593-603` (parse), `natives/regexp.rs:8-39` `regexp_flag_string`, `:185-194` `regexp_flags_units`, `interp.rs:3535` `regexp_flag_bit_for` | 4 sites enumerating the 9 flags; drift risk if a flag is added |
| Plain vs regexp `replace`/`replaceAll`/`split` string branches | `natives/regexp.rs:1309`, `:1370`, `:2235` | parallel scan/slice loops over UTF-16 units |
| Fuzz-regression meter-overflow tests | `tests/finding_*_regexp_meter_overflow.rs` ×6 | near-identical harness bodies differing only in PATTERN/SUBJECT/EXPECTED; could be one table-driven test |

No cross-crate Unicode-table duplication: the generated property tables live only in
`ironhorse-regexp`; identifier classification is shared from `ironhorse-unicode`
(`unicode.rs` re-exports it; `ironhorse-compile` depends on the same crate). (Lead that
survived as a positive.)

## Skipped features and refusals inventory

| Site | Refused / skipped | Spec status | Should support? | Effort |
|---|---|---|---|---|
| `matcher.rs:127` `MAX_MATCH_STATES` (RGX-1) | long/greedy matches past 64Ki states → `HeapExhausted` | ES-262 (all valid) | yes — common benign inputs | medium (single-charset quantifier special-case) |
| `property_read.rs` implicit getters (RGX-2) | prototype accessors as own properties | ES-262 22.2.6 | yes | medium |
| `natives/regexp.rs:1100` result props (RGX-3) | `index/input/groups/indices` unless spelled | ES-262 22.2.7.2 | yes | low |
| `natives/regexp.rs:364` `Halt::NotImplemented(regexp_feature)` | any pattern that still hits `CompileError::Unsupported` | — | — | the crate self-names; grep found no live `Unsupported(` emit site in `compile.rs` beyond the enum variant, so the honest-skip surface is currently empty in practice |
| test262 `property-escapes/generated`, `CharacterClassEscapes/*-positive`, `quantifier-integer-limit` | `skip:ironhorse-aborted-limit` | — | consequence of RGX-1 | — |
| `annexB/.../compile/*` duplicate-named / flags-invalid | `skip:shared-test262-failure` | AnnexB | upstream/shared harness gap, not engine | — |
| `unicodeSets/generated@@0000/0001` | 216 `skip:shared-positive-test-failure` + 8 aborted-limit | `v` generated | mostly shared-harness; the 8 aborted are RGX-1 | — |

## Memory and performance opportunities

| Site | Waste | Magnitude | Fix |
|---|---|---|---|
| `compile.rs:2090` string-set lowering (RGX-4) | `\p{RGI_Emoji}`/`\q{}` expand to a disjunction subtree | 257 KB `code` per `/\p{RGI_Emoji}/v`; 2000 retained ≈ 500 MB (measured) | dedicated string-set matcher node; dedup identical programs |
| `compile.rs:1261,1422` whole-range fold (RGX-4) | iterate every fold mapping / every code point in range | `[\0-\u{10FFFF}]/iu` = 417 824 compile computrons, 137 ms | intersect property with fold-table domain |
| `natives/regexp.rs:1041` per-exec re-encode (RGX-5) | re-encode + re-scan whole subject per global match | O(n·m); 3-9 s at n=16000 vs node <0.2 s | encode once, resume from byte offset |
| `natives/regexp.rs:946` matchAll re-decode | subject re-`new_string_units` each `next()` | O(n) per yielded match; `HeapExhausted` at n=16000 | keep encoded subject in iterator state |
| `matcher.rs:83` per-state capture clone | each backtrack `State` clones the full captures `Vec` | ~95 bytes/state measured (`(a)*` n=60000 → 6.2 MB, 60 018 allocs) | copy-on-write / delta captures, or a shared snapshot arena |
| generated tables | `unicode_properties_generated.rs` ≈ 184 KB i32 payload (441 statics); 74 `Script_*` tables byte-identical to their `Script_Extensions_*` twin | ~7.4 KB duplicate ranges; `SCRIPT_UNKNOWN`/`SCRIPT_EXTENSIONS_UNKNOWN` alone 5.88 KB ×2 | have `lookup_script`/`lookup_script_extensions` share one static where the two are identical |

## Ontology notes

- **`SlotIndex` as the RegExp identity** (`regexps: HashMap<SlotIndex, RegExpData>`): the
  same bare `SlotIndex`/`u16` stands for a RegExp instance, a getter-name id, a
  result-property id, and an interned key. RGX-2/RGX-3 are the guest-visible consequence of
  conflating "the string `global`" with "the program-local id that happens to carry the
  implicit getter": a name has a *concept* identity (the accessor) only if it also has an
  *identifier* identity (a symbol-table slot). Promoted to RGX-2, RGX-3.
- **`resource_limit` vs `host_allocation_failed` vs `aborted`** (`MatchOutcome`,
  matcher.rs:44-68): three booleans partition "the match stopped early", but the VM collapses
  `resource_limit → HeapExhausted`, `host_allocation_failed → HostAllocationFailed`,
  `aborted → MeterAbort` (natives/regexp.rs:553-561). `resource_limit` names two different
  conditions (the `MAX_MATCH_BYTES`/`MAX_MATCH_STATES` ceiling, and the `base_bytes >
  MAX_MATCH_BYTES` pre-check) that are both "deterministic ceiling" — consistent. But
  `aborted` is documented (matcher.rs:58-61) as *both* "the check callback refused" *and* "a
  finite dispatch budget or an invalid reference operand" — three unrelated causes under one
  flag, and the VM cannot tell a meter refusal from a corrupt-operand abort (both become
  `MeterAbort`). A corrupt reference operand (matcher.rs:401,410,465,474) reaching guests as
  `RangeError`-ish `MeterAbort` is a misclassification, though it is only reachable from a
  malformed program the compiler does not emit.
- **"compile meter" naming**: `Program.compile_meter_raw` and `work_meter_raw`
  (`CompileOutcome`) are the same quantity at different stages; `compile_computrons()` vs
  `match_computrons()` vs the VM's `computrons`/`meter_raw`/`meter_raw_this_run` are four
  names for raw-vs-shifted meter readings. Consistent arithmetic (`>> 16`), but the
  vocabulary ("meter"/"work"/"charge"/"computron") is used interchangeably across the
  crate boundary.
- **`flags: String` vs `code[0]: u32` vs the canonical flag order**: `RegExpData` stores
  flags three ways — the compiled bit-word `program.flags()`, a canonical `flags: String`
  (built once by `regexp_flag_string`), and re-derived `Vec<u16>` units
  (`regexp_flags_units`). The order `d g i m s u v y` is re-encoded at four sites (see
  Duplication). No divergence found, but "the flags of a RegExp" has three in-memory
  representations kept in sync by hand.
- **`XS_REGEXP_NAME` bit** (flags.rs) is a *transient* parser bit packed into the same word
  as the eight real flags; it is masked off before `code[0]` is written. A homonym on the
  flags word (persistent flags vs parse-transient state) that is safe only because the
  masking is correct at every exit — a latent hazard if a new transient bit is added.

## Leads that did not survive

- **Native-stack overflow on deep nesting / long subjects** — the parser, measure, emit, and
  matcher all use explicit `Vec` work-stacks, not recursion; nesting is bounded by
  `MAX_NESTING_DEPTH = 512` with a catchable `SyntaxError`, and pattern length is heap-linear.
  No native recursion reachable from guest input. (Design strength.)
- **Catastrophic backtracking unmetered** — the matcher *does* meter every step and expose
  1024-step interruption; only the *unarmed* host fails to enforce a bound. Recorded as the
  narrower RGX-6 rather than a metering hole.
- **Cross-crate Unicode-table duplication** — checked `ironhorse-compile`/`ironhorse-text`/
  `ironhorse-vm`; none carries its own general-category/property tables, and identifier
  tables are shared from `ironhorse-unicode`. No duplication.
- **Nondeterminism (HashMap iteration, float, address)** — the matcher/compiler are pure
  integer/byte work; `capture_group_names` is a `Vec` in first-seen order; charset sorts are
  `sort_unstable` + `dedup` on total orders. GC roots are explicitly sorted
  (`gc.rs` `gc_roots`). No nondeterminism found in-region.
- **CESU-8 surrogate handling under `u`** — `find_character`/`cesu8_decode` correctly keep
  lone surrogates standalone and combine only valid pairs; the lookbehind backref byte
  arithmetic (matcher.rs:414-456) is a deliberate, documented XS-faithful quirk
  (designs/ironhorse-known-defects.md), not a new bug.
- **`cross-plane fold` over-match** (p11 `/\u{20400}/iu` matches `\u{20428}`) — this is
  XS-faithful: `FOLD1` is keyed by the low 16 bits and applied across all planes
  (charcase.rs:2393-2399 documents the false-positives-across-planes behavior). A divergence
  from Node, but an intended XS-parity departure, not an in-region defect.
