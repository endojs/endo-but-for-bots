# Map: VM value built-ins: strings, numbers, BigInt, JSON, Date, Intl, Temporal

Reviewed commit `61cd656cb`.

## Scope

All paths are under `rust/engine/ironhorse-vm/src/`. Line counts are from `wc -l` at `61cd656cb`.

| File | Lines | Role |
|---|---:|---|
| `interp/natives/json.rs` | 2245 | `JSON.parse` / `stringify` / `rawJSON` / `isRawJSON`, reviver walk |
| `interp/natives/string.rs` | 831 | `String.prototype` methods except the regexp-protocol ones; `String.fromCharCode` / `fromCodePoint` / `raw` |
| `interp/natives/string/slice_tests.rs` | 118 | unit tests |
| `interp/natives/number.rs` | 530 | `Math.*`, `Number.prototype.*`, `parseInt`, `parseFloat`, `isNaN`, `isFinite` |
| `interp/natives/bigint.rs` | 668 | BigInt operators, `asIntN` / `asUintN`, `**`, shifts, chunk codec |
| `interp/bigint.rs` | 474 | limb arithmetic, StringIntegerLiteral parsing, decimal rendering |
| `interp/numeric.rs` | 805 | `parseInt` / `ToNumber(string)` cores, radix `toString`, `toFixed` / `toExponential` / `toPrecision` |
| `interp/coerce.rs` | 1068 | ToPrimitive / ToNumber / ToString, `+`, relational and equality operators |
| `math.rs` | 89 | libm provider selection |
| `interp/natives/base64.rs` | 471 | Uint8Array base64 / hex |
| `interp/natives/uri.rs` | 207 | `encodeURI*` / `decodeURI*` |
| `interp/natives/sum_precise.rs` | 341 | `Math.sumPrecise` |
| `interp/natives/date.rs` | 242 | Date statics and methods (u8 op codes) |
| `interp/date.rs` | 436 | civil-calendar math, `Date.parse` grammars, display strings |
| `interp/natives/intl.rs` | 1575 | Intl option reading, Locale, DateTimeFormat / NumberFormat construction |
| `intl_number.rs` | 1885 | NumberFormat engine (Decimal, rounding modes, notation, affixes) |
| `interp/locale.rs` | 988 | locale canonicalization, DTF parts, list / plural tables, collation, segmentation |
| `interp/intl_data.rs` | 190 | Intl record structs |
| `intl_profile.rs` | 4 | generated `INTL_DATA_VERSION` |
| `interp/temporal.rs` | 1494 | Temporal records, ISO arithmetic, parsing, rounding, time-zone table |
| `interp/natives/temporal.rs` | 1917 | Temporal method bodies (u8 op codes for Plain*, Zoned, Now) |
| **Total** | **16578** | |

## What was read

- **Read in full:** `string.rs`, `number.rs`, `natives/bigint.rs`, `interp/bigint.rs`, `numeric.rs`, `coerce.rs`, `math.rs`, `uri.rs`, `sum_precise.rs`, `natives/date.rs`, `interp/date.rs`, `locale.rs`, `intl_data.rs` (first 60 lines), `intl_profile.rs`, and `json.rs`.
- **Read in part (targeted):**
  - `intl.rs`: lines 1–470 and 1280–1340, plus a function list.
  - `intl_number.rs`: lines 215–535 and 760–950, plus an item list.
  - `temporal.rs`: lines 1–260, 715–805, 924–1190 and 1300–1494.
  - `natives/temporal.rs`: lines 1–480 and 1740–1800.
  - `base64.rs`: lines 1–200.
- **Neighbours read to follow control flow:**
  - `interp/strings.rs` (concat, string allocation) and `interp/text.rs` (case mapping, normalization, CESU-8).
  - `interp/admission.rs:84–302` (charge / admission helpers) and `meter.rs:1–370`.
  - `ironhorse-meter/src/lib.rs` (weights).
  - `value.rs:2330–2610` (chunk arena ceiling and alloc) and `value.rs:3062–3110` (`number_to_ecma_string`).
  - `interp/boot.rs:2725–2800` (Date table).
  - `interp/dispatch/property_read.rs:1–330` (synthesized Temporal / Intl getters).
  - `interp/natives/dispatch.rs:1560–1600, 2825–2850, 3146–3156, 7540–7600`.
  - `interp.rs:3672–3708` (`bi_to_radix`).
  - `interp/gc.rs:90–140`, `RECLAMATION.md`, and the `ironhorse-xst` host source.
- **Executable probes:** about 25 JS probe files compared against Node 22, and two Rust metering probes. I also ran a plain-host test262 sweep (my own runner) over `built-ins/{JSON,String,Number,BigInt,Date,Math,parseInt,parseFloat,Uint8Array,decodeURIComponent,encodeURIComponent,Temporal}` and `intl402`.

## What was not read

- `intl.rs` lines 470–1280 and 1340–1575 were only skimmed by function name: the DTF method bodies, `set_number_digit_options`, `build_number_format` and the parts arrays.
- `intl_number.rs` was not read in its rendering and affix sections: lines 535–760 and 950–1885.
- `natives/temporal.rs` lines 480–1740 and 1800–1917 were not read (Duration, Instant, Zoned and Now bodies). Their behaviour was sampled only by probes and test262.
- `temporal.rs` lines 260–715 (date add / until / difference) and 805–924 (duration parse / format) were not read.
- `base64.rs` lines 200–471 (the encoders and the `setFrom*` methods) were not read.
- `string/slice_tests.rs` was not read.
- The regexp-backed String methods (`split`, `replace`, `match*`, `search`) live outside these files and were not reviewed.
- Whether NativeMethod u8 op codes are persisted in snapshots was not checked.

## Architecture as built

**String values.**
- Strings are immutable chunks in the chunk arena. Each chunk has a 4-byte little-endian length header (`value.rs:1717`), and its payload is UTF-16 code units stored big-endian (`interp/strings.rs:9–23`), so a byte compare gives code-unit order.
- The empty string is *not* interned. `new_string_units(&[])` calls `chunks.alloc(&[])`, which appends a fresh 4-byte chunk (`strings.rs:113–118`, `value.rs:2512–2586`).
- Most builtins first decode the whole receiver into a `Vec<u16>` (`string_this_units`, `string.rs:30–45`). The "indexed" methods (slice, `at`, `indexOf`, ...) instead read units in place via `str_unit_at` (`string.rs:226–540`).
- `+` (`concat_add`, `strings.rs:130–142`) works like this:
  1. It decodes both operands (two `Vec<u16>`).
  2. It joins them into a third `Vec`.
  3. It re-encodes to BE bytes (a fourth buffer).
  4. It appends that buffer to the arena.
  It charges `tick_string(len)` but has no meter check.
- No garbage is collected within a crank (`RECLAMATION.md:63`; `collect_garbage` requires quiescence, `interp/gc.rs:110`). Every intermediate string therefore lives until the crank ends, under a 256 MiB default chunk ceiling (`value.rs:15`).

**Metering vocabulary** (`admission.rs`, `meter.rs`).
- `meter.tick_*` adds cost with no check.
- `charge_and_check` adds cost and consults the host.
- `reserve_units` bounds a UTF-16 result to `0x7fff_ffff` units (a catchable RangeError) and to the heap ceiling (a `HeapExhausted` halt), then charges the chunk cost.
- `admit_scratch` checks the heap only and charges 0.
- `new_reserved_string_units` charges nothing, because it assumes a prior `reserve_units`.
- One raw unit is 1/65536 computron. `CODE_METERING` / `BUILTIN_METERING` / `BIGINT_METERING` are on the order of 1 computron (`ironhorse-meter/src/lib.rs`).

**Numbers.**
- `Number(string)` / `ToNumber` goes through `string_to_number` (`numeric.rs:206`). The decimal body is parsed by Rust's correctly rounded `f64` parse. `0x` / `0o` / `0b` bodies are accumulated in `f64`.
- `parseInt` (`numeric.rs:63`) accumulates `result * radix + digit` in `f64`.
- Radix-10 `ToString` is `number_to_ecma_string` (`value.rs:3062`), which takes the shortest digits from Rust's `{:e}`.
- Radix `toString` is a port of the XS/V8 algorithm (`numeric.rs:121`).
- `toFixed` / `toExponential` / `toPrecision` round the exact decimal expansion obtained from `format!("{x:.1100}")` (`numeric.rs:604`).
- `Math.*` uses `crate::math`. That is the platform libm unless `deterministic-math` is enabled, which the `consensus` feature does (`Cargo.toml:52–54`).

**BigInt.**
- A BigInt is a chunk holding `[sign:u8][LE u32 limbs]`, trimmed (`natives/bigint.rs:378–397`).
- Every operation decodes both operands into fresh `Vec<u32>`s (`read_bigint`, `natives/bigint.rs:75`) and re-encodes the result.
- Multiply is schoolbook (`bigint.rs:97`).
- Divide is bit-at-a-time binary long division: per quotient bit one compare, one allocating subtract and one shift (`bigint.rs:118–153`).
- Decimal rendering for `ToString` is `bi_to_decimal`, using base 10^9 (`bigint.rs:351`). `BigInt.prototype.toString(radix)` is a separate per-digit `bi_to_radix` (`interp.rs:3672`).
- Arithmetic charges the result chunk plus `(result_limbs-1)·BIGINT_METERING`, after the work (`natives/bigint.rs:438–491`).
- `**`, `<<` and `asIntN` / `asUintN` are capped at 64 Ki result bits with `Halt::Refused` (`natives/bigint.rs:233, 308, 628`). `*` has no cap.

**JSON.**
- Parse converts the string to `Vec<u16>` and then to WTF-8 (`json.rs:515–526`). It uses an explicit container stack (`JsonParseFrame`), and each nesting level charges one unit of the shared 2048-unit native-depth budget (`json.rs:1323–1380`, `interp.rs:409`).
- With a reviver, a parallel `JsonSource` tree (40 B per node) keeps token ranges for `context.source`.
- Stringify also uses an explicit frame stack (`JsonStrFrame`). Each child serialization is a separate `Vec<u16>` that is copied into its parent's buffer at close (`json.rs:1213–1251`).
- Stringify output growth is prepaid through `json_reserve_output`. The per-node cost is accumulated in `cost` and charged at container open and at the end (`json.rs:470–496, 1048–1092`).

**Date.**
- A Date's time value lives in the `dates` side table.
- The `Date.*` and `Date.prototype.*` functions are `NativeMethod::Date(u8)`, with the op numbers assigned in `boot.rs:2734–2790`. `natives/date.rs` matches on numeric literals (0–36).
- Local time equals UTC. `getX` and `getUTCX` share one op, and `getTimezoneOffset` is 0.
- `Date.now()` is the constant `0` (`natives/date.rs:50`).
- `toLocale*String` are the `toString` ops (`boot.rs:2766–2768`).
- `Date.parse` tries a strict ISO parser, then an XS-compatible lax ISO parser, then the engine's own `toString` / `toUTCString` shapes (`date.rs:98–103`).

**Intl.**
- A "frozen profile" made of hand tables in `locale.rs`, `intl_number.rs` and `text.rs`.
- ICU4X is used only for NFC/NFD/NFKC/NFKD normalization (`text.rs:157`, `locale.rs:913`) and for segmentation (`locale.rs:310`).
- Collation is NFC, then `to_lowercase`, then code-point order with a code-point tie-break (`locale.rs:903–964`).
- Option records in `intl_data.rs` are bags of `String`. `NfResolved` in `intl_number.rs` uses enums.
- There is no metering anywhere in `intl.rs`, `locale.rs`, `intl_number.rs`, `temporal.rs` or `natives/temporal.rs` (zero `charge` / `tick` / `reserve` / `admit` call sites). Only result-string allocation is charged.

**Temporal.**
- Records live in side tables: `TemporalPlainRecord` with a `kind: u8` of 0–5 where 5 is the obsolete Calendar, plus Duration / Instant / Zoned records (`temporal.rs:7–68`).
- Time zones are a fixed-offset table of 23 IANA names at their standard offset, plus UTC, numeric offsets and `Etc/GMT±N` (`temporal.rs:1415–1494`). This table is shared with `Intl.DateTimeFormat` (`intl.rs:450–459`).
- Temporal and Intl getters (`years`, `month`, `epochNanoseconds`, `Collator.prototype.compare`, ...) are not installed as accessors. They are synthesized on the static `GET_PROPERTY` opcode path by name-string match (`dispatch/property_read.rs:44–298`).

## Candidate findings

### NVAL-1 — `String.prototype.includes` runs an unmetered O(n·m) search, and `indexOf` / `lastIndexOf` charge 1/65536 computron per compare

- **Lens(es):** 1 (metering hole: unbounded work before a check), 4.
- **Proposed severity:** high.
- **Location:** `ironhorse-vm/src/interp/natives/string.rs:434–451` (includes), `:496–535` (indexOf / lastIndexOf).
- **Excerpt:**
  ```rust
  // includes_aux scan does NOT meter the per-byte compares ... so the search runs unmetered.
  StringIncludes => { ... self.meter.tick_raw(STRING_METERSOME_FRAME_METERING);
      let found = sub.is_empty() || (sub.len() <= length - bfrom && (bfrom..=length - sub.len()).any(|at| ...
  // indexOf:
  while matched < search.len() && unit_at(self, candidate + matched) == search[matched] {
      self.charge_and_check(1)?;   // one RAW unit = 1/65536 computron
  ```
- **Mechanism:**
  - `includes` performs a naive search over candidates × needle length, calling `str_unit_at` (with a bounds check) for each unit. It charges only a fixed frame cost and has no check point inside the loop.
  - `indexOf` checks per matched unit but charges a single raw unit, so the charge is about 65536× too small.
  - Both use the quadratic algorithm, where a two-way or memchr-style search would be linear.
- **Scenario:** `'a'.repeat(2e5).includes('a'.repeat(1e5)+'b')` keeps the host busy for minutes on about 15k computrons. A host meter limit cannot fire until the call returns.
- **Evidence:** confirmed by probes.
  - xst `m_includes.js` (`const h='a'.repeat(200000); const n='a'.repeat(100000)+'b'; h.includes(n)`) took **169.7 s**.
  - Rust probe `zz_audit_nval_2.rs` armed the meter with a limit of 20,000 computrons (source below). Output: `includes limit=20000 completed=true computrons=15047 ms=7962.2 halt=Return`. The control loop under the same limit aborted after 0.8 ms (`computrons=20028 halt=MeterAbort`).
  - Probe 1 measured 3.2 computrons/ms for `includes` and 3.6 computrons/ms for `indexOf`, against about 9,300–11,500 computrons/ms for ordinary code.
- **Recommendation:**
  - Charge `charge_builtin_work` per compared unit, or per candidate × min(m, matched + 1), with periodic `charge_and_check`.
  - Better, switch to a linear-time search (Two-Way / `memchr::memmem` over the BE16 bytes with alignment checks). Charging per input unit then becomes honest.
  - Use the same helper for `includes`, `indexOf`, `lastIndexOf`, `startsWith` and `endsWith`.
- **Confidence:** confirmed by probe.

### NVAL-2 — BigInt multiply, divide, decimal rendering and string parsing do quadratic work for linear (or zero) charge; `*` has no size cap while `**` does

- **Lens(es):** 1 (metering hole, charge after the work), 4, 6.
- **Proposed severity:** high.
- **Location:**
  - Multiply: `interp/bigint.rs:97–113`.
  - Divide: `interp/bigint.rs:118–153`.
  - Arithmetic charging: `interp/natives/bigint.rs:438–491`.
  - `bi_to_decimal`: `interp/bigint.rs:351–378`, used by `ToString` at `interp/strings.rs:206–212`, `property/keys.rs:496` and `render.rs:108`.
  - `parse_bigint_string`: `interp/bigint.rs:428–474`, used by `BigInt(str)` (`natives/dispatch.rs:1583–1595`), `to_bigint_value`, and BigInt↔String `<` / `==` (`coerce.rs:588–605, 653–669`).
  - Caps: `natives/bigint.rs:308, 338–349, 628`.
- **Excerpt:**
  ```rust
  // natives/bigint.rs:485-489 — after bi_mul / bi_div_rem_mag have already run
  self.meter.tick_chunk_new(alloc_limbs * 4);
  self.meter.tick_raw((size - 1) * crate::meter::BIGINT_METERING);   // linear in RESULT limbs, no check
  // bigint.rs:145-151 — one allocating subtract per quotient BIT
  for bit in (0..=shift).rev() { if bi_cmp_mag(&remainder, &shifted_divisor) != Ordering::Less {
      remainder = bi_sub_mag(&remainder, &shifted_divisor); ...
  ```
- **Mechanism:**
  - Work is O(n·m) for `*`, O(bits·n) with an allocation per step for `/` and `%`, O(n²) for `String(big)` and O(d²) for parsing a d-digit string.
  - The charge is linear in result size (or zero, for `String(big)` beyond the output chunk and for `BigInt(str)` / `1n < str` beyond the result chunk) and lands after the work.
  - `**` and `<<` refuse results above 64 Ki bits "so one opcode cannot monopolize the host" (`natives/bigint.rs:305–308`). Yet `x*x` on two 1M-bit values is allowed, so the cap protects nothing.
  - `BigInt.prototype.toString` (`bi_to_radix`) is metered quadratically but is about 13× slower than the unmetered `String(x)` path that renders the same digits. The two paths disagree.
- **Scenario:** A guest builds `x = (1n<<65000n)-1n` and squares it repeatedly, or divides, or calls `String(x)` or `BigInt('7'.repeat(2e5))`. Each statement runs for seconds while costing tens of thousands of computrons.
- **Evidence:** confirmed by probes. Rust probe `zz_audit_nval_1.rs` (source below) output, in computrons / ms / ratio:
  ```
  baseline-loop  computrons=67500034 ms=7249.0 computrons/ms=9311.6
  baseline-str   computrons= 7125388 ms= 619.0 computrons/ms=11510.9
  bigint-mul     computrons=  128117 ms=2198.9 computrons/ms=58.3     (5 squarings from 2031 limbs)
  bigint-div     computrons=   28493 ms=1738.9 computrons/ms=16.4     (8125-limb / 2000-limb)
  String(big)    computrons=   20357 ms= 179.6 computrons/ms=113.4
  big.toString   computrons=79523920 ms=2884.1 computrons/ms=27573.2  (same digits, metered path)
  BigInt(str)    computrons=   50035 ms=1563.2 computrons/ms=32.0     (200,000 digits)
  1n<str         computrons=   50029 ms=1636.4 computrons/ms=30.6
  ```
  The undercharge is 80–600× against ordinary code. The xst probe `big3.js` (`10n ** 20000n`) halted with `Refused("exponentiation:result-too-large")`; Node returns a 20,001-digit value.
- **Recommendation:**
  1. Precharge with `charge_and_check` the work estimate before the operation: `|a|·|b|` limbs for `*`, `(|a|-|b|+1)·|b|` for `/` and `%`, `d²/9` for parse and render.
  2. Replace binary long division with Knuth Algorithm D. That is roughly 32× fewer passes and no per-step allocation.
  3. Route `ToString(bigint)` through one renderer with one charge, and delete `bi_to_radix` or `bi_to_decimal`.
  4. Make the size policy uniform: cap `*` like `**`, or replace all the caps with metered work.
  5. Make the result-size refusal a catchable RangeError, as V8 does ("Maximum BigInt size exceeded"); see NVAL-9.
- **Confidence:** confirmed by probe.

### NVAL-3 — String append in a loop exhausts the heap at about 15,000 iterations: flat strings, four copies per `+`, no intra-crank collection

- **Lens(es):** 4, 1.
- **Proposed severity:** high.
- **Location:** `ironhorse-vm/src/interp/strings.rs:130–142` (`concat_add`, adjacent to this region), `interp/strings.rs:170–172` (`to_string_units_metered` decodes a full copy), `value.rs:15` (256 MiB ceiling), `RECLAMATION.md:63` ("No collection runs within a crank.").
- **Excerpt:**
  ```rust
  let ua = self.to_string_units_metered(a);      // copy 1 (decode)
  let ub = self.to_string_units_metered(b);
  let mut joined = Vec::with_capacity(ua.len() + ub.len());   // copy 2
  ...
  let off = self.chunks.alloc(&units_to_be16(&joined));       // copy 3 (encode) + copy 4 (append)
  ```
- **Mechanism:**
  - Every `s += c` allocates a fresh chunk of the whole result.
  - Garbage cannot be reclaimed until the crank ends, so total allocation is Σ 2i bytes, which is O(n²) memory.
  - There is no rope, no builder, and no in-place append for a uniquely referenced tail chunk.
- **Scenario:** Ordinary code that builds output by concatenation fails with `HeapExhausted` on outputs of about 16 KB of text. Examples: serializers, template assembly, `for (...) out += line`.
- **Evidence:** confirmed by probe (xst; Node completes all sizes in about 0.06 s).
  ```js
  let s = ''; for (let i = 0; i < N; i++) { s += 'x'; } if (s.length !== N) throw new Error('bad');
  ```
  | N | Result | Time |
  |---:|---|---:|
  | 5000 | ok | 0.09 s |
  | 10000 | ok | 0.20 s |
  | 15000 | ok | 0.78 s |
  | 18000 / 20000 / 25000 / 1e5 / 2e5 | `InternalError: ironhorse halted: HeapExhausted` | — |

  The Rust probe measured `concat-15000 computrons=294262 ms=888.5` (331 computrons/ms, about 30× under baseline).
- **Recommendation:**
  - Either introduce a rope or concat-node string representation that is flattened lazily, or permit appending in place into a chunk at the arena tail when the left operand's chunk is the last allocation and is unaliased. XS relies on GC instead; ironhorse has no mid-crank GC.
  - At minimum, build the joined BE16 payload directly from the two stored payloads, which needs no decode or encode: one copy instead of four.
- **Confidence:** confirmed by probe.

### NVAL-4 — Temporal and Intl getters exist only on the static `.name` opcode path; `obj[k]`, `Reflect.get`, Proxies and descriptors see `undefined`

- **Lens(es):** 1, 6 (properties that are not part of the object model), 5.
- **Proposed severity:** high.
- **Location:**
  - `ironhorse-vm/src/interp/dispatch/property_read.rs:44–298`: Instant at 44–53, Duration at 54–73, Plain at 74–128, Zoned at 129+, Locale at 250+, `Collator.compare` at 285–298.
  - The Temporal / Intl prototypes do not install accessors (seen via descriptor probes).
- **Excerpt:**
  ```rust
  Payload::Reference(inst) if (obj.kind == Kind::Reference && self.temporal_durations.contains_key(&inst)) => {
      let d = self.temporal_durations[&inst];
      match self.scalar_key_text(id).as_deref() {   // allocates a String per read
          Some("years") => Slot::number(d.years as f64), ... Some("blank") => ...
  ```
- **Mechanism:**
  - The getter values are produced by `dispatch_get_property` before the ordinary MOP runs, by matching on the key text.
  - Every other route to [[Get]] goes straight to `mop_get`: computed member access, `Reflect.get`, Proxy targets, `super`, and others. Those routes find no property.
  - `getOwnPropertyDescriptor(proto, 'years')` is `undefined`, and `'blank' in Temporal.Duration.prototype` is `false`.
  - An own data property cannot shadow the synthesized value.
  - A non-branded receiver such as `Object.create(d)` gets `undefined` where the spec requires a TypeError.
- **Scenario:** Each of these silently yields `undefined` instead of the field:
  - `for (const f of ['years','months']) total += d[f]`
  - membranes and SES-style Proxies wrapping Temporal values
  - `Reflect.get(collator, 'compare')`
- **Evidence:**
  - Confirmed by probe (`getter1.js`, xst). Output: `["1","undefined","undefined","1","undefined","undefined","1","undefined","undefined","undefined","3,undefined,undefined","3"]`, in this order:
    - `d.years` is 1, but `d['ye'+'ars']`, `Reflect.get(d,'years')` and `new Proxy(d,{}).years` are `undefined`.
    - Destructuring gives 1.
    - After `defineProperty(d,'years',{value:99})`, `d.years` is still 1.
    - `Reflect.get(c,'compare')`, `c['comp'+'are']` and `Intl.Collator.prototype.compare` are `undefined`.
    - For a PlainDate, `p.month` is 3 while `Reflect.get(p,'month')` and `p['mon'+'th']` are `undefined`.
  - `desc1.js`: `Object.getOwnPropertyDescriptor(Intl.DateTimeFormat.prototype,'format')` is `{"writable":true,"enumerable":false,"configurable":true}`, a data property whose value is `undefined`.
  - test262 (plain host, my runner): 215 `built-ins/Temporal` failures with `TypeError: cannot coerce undefined to object` (e.g. `built-ins/Temporal/Duration/prototype/blank/prop-desc.js`). There are 86 more in `intl402` (e.g. `intl402/Collator/prototype/compare/builtin.js`, `length.js`).
- **Recommendation:**
  - Install real accessor properties (getter natives with brand checks) on each Temporal / Intl prototype at boot, and delete the opcode special cases.
  - If a fast path is wanted, key it on the resolved accessor, not on the key text, and drop the per-read `String` allocation of `scalar_key_text`.
- **Confidence:** confirmed by probe.

### NVAL-5 — `Intl.Collator` and `localeCompare` are not UCA: accents sort after `z`, case order is upper-first, `base` / `accent` sensitivity does not fold accents, and `numeric` compares only the first digit run

- **Lens(es):** 1, 3 (approximation), 4 (unmetered, clones).
- **Proposed severity:** high (wrong results on a common path; medium if the approximation is accepted profile policy).
- **Location:** `ironhorse-vm/src/interp/locale.rs:903–988`, called from `interp/natives/string.rs:651–670` and `natives/dispatch.rs:2828–2844`.
- **Excerpt:**
  ```rust
  original.extend(text.chars().map(u32::from));
  folded.extend(text.to_lowercase().chars().map(u32::from));
  ... let ordering = if data.numeric { numeric_collation_cmp(&left_key, &right_key) } else { left_key.cmp(&right_key) };
  Ordering::Equal if data.sensitivity == "case" || data.sensitivity == "variant" => { ... _ => left.cmp(&right) ...
  // numeric_collation_cmp: parses only the FIRST digit run of each side and compares those,
  // regardless of the text before it; falls back to code-unit order on a tie.
  ```
- **Mechanism:**
  - Primary order is code-point order of the lowercased NFC string, so `ä` (U+00E4) sorts after `z`.
  - On a tie, the original code points decide, so `'A' < 'a'`, the reverse of CLDR's default lower-first.
  - `sensitivity: 'base'` / `'accent'` compare the same folded key, so accents are never ignored.
  - With `numeric`, `'b1'` sorts before `'a2'`.
  - In the `compare` bound function, each call clones `CollatorData` (five `String`s), builds new NFC and lowercase `Vec<u32>` and `String` buffers without admission, and charges nothing per unit.
- **Scenario:** Sorting user-visible names with `localeCompare` or `Intl.Collator().compare` produces a different order from every browser and Node: accented names go last, and capitals sort before lowercase.
- **Evidence:** confirmed by probe (`str1.js`, `exist1.js` vs Node).
  - `'a'.localeCompare('A')`: IH 1, Node -1.
  - `'ä'.localeCompare('z','de')`: IH 1, Node -1.
  - `['b','a','C','á'].sort(localeCompare)`: IH `a,b,C,á`, Node `a,á,b,C`.
  - `'a'.localeCompare('á',u,{sensitivity:'base'})`: IH -1, Node 0.
  - `'Straße'` vs `'Strasse'` at base: IH 1, Node 0.
  - `['ä','a','z']` sorted with `Intl.Collator('de')`: IH `a,z,ä`, Node `a,ä,z`.
  - `'b1'.localeCompare('a2',u,{numeric:true})`: IH -1, Node 1.
  - `'a10b2'` vs `'a10b10'` with `numeric`: IH 1, Node -1.
  - `Intl.Collator('en',{sensitivity:'accent'}).compare('a','A')`: IH -1, Node 0.
  - Rust probe: `localeCompare` on 1M-unit strings ran at 513 computrons/ms against about 10k baseline.
  - test262 `intl402/Collator`: 44/65 pass.
- **Recommendation:**
  - Use `icu_collator` (the same ICU4X 2.2 family already locked) with root data plus the profile locales.
  - Otherwise, document the collator as code-point order, and stop advertising `sensitivity` / `numeric` / `caseFirst` as honoured.
  - Charge per input unit, and cache the resolved collator instead of cloning `CollatorData` per call.
- **Confidence:** confirmed by probe.

### NVAL-6 — The time-zone model is fixed-offset at standard time: DST is ignored for Temporal and `Intl.DateTimeFormat`, offsets valid in summer are rejected, and most IANA zones are refused

- **Lens(es):** 1, 3.
- **Proposed severity:** high.
- **Location:** `ironhorse-vm/src/interp/temporal.rs:1410–1494` (`resolve_time_zone` table of 23 zones), `temporal.rs:1168–1174` (Zoned reuse), `interp/natives/intl.rs:450–459` (DTF timeZone).
- **Excerpt:**
  ```rust
  // Common IANA zones at their standard offset (DST not modeled).
  ("america/new_york", "America/New_York", -300), ... ("europe/london", "Europe/London", 0), ...
  ```
- **Mechanism:**
  - Each named zone maps to one constant offset.
  - `parse_temporal_zoned` requires the bracketed offset to match that constant (`temporal.rs:1176–1178`). A correct summer string is therefore a RangeError.
  - Zones outside the table are RangeErrors that look like invalid-input errors (see NVAL-9).
- **Scenario:** Any conversion of a summer instant for New York, London, Berlin or Sydney is off by one hour. The ISO string `Temporal.ZonedDateTime.prototype.toString()` itself produces in other engines cannot be parsed back.
- **Evidence:** confirmed by probe.
  - `tz1.js` vs Node (TZ=UTC):
    - `America/New_York` 2024-07-01 12:00Z: IH `7:0 AM GMT-5`, Node `8:00 AM EDT`.
    - London July: `12:0 PM GMT+0` vs `1:00 PM GMT+1`.
    - Sydney January: `10:0 PM GMT+10` vs `11:00 PM GMT+11`.
    - `Pacific/Chatham`, `Europe/Kyiv`, `Antarctica/Troll`: IH RangeError.
  - `tmp1.js` (IH only; Node 22 has no Temporal):
    - `ZonedDateTime.from('2024-07-01T12:00[America/New_York]').offset` is `-05:00`.
    - `ZonedDateTime.from('2024-07-01T12:00-04:00[America/New_York]')` throws `RangeError: invalid zoned date/time string`.
- **Recommendation:**
  - Embed a frozen tzdb snapshot (e.g. `jiff-tzdb` or `chrono-tz` compiled data), versioned inside `INTL_DATA_VERSION` so replicas stay deterministic, and apply transition rules.
  - Until then, refuse named zones that have DST, rather than answer with the wrong offset.
- **Confidence:** confirmed by probe.

### NVAL-7 — Temporal is an outdated, lax subset: about 44% test262 pass, invisible to the CI gate, and entirely unmetered

- **Lens(es):** 1, 3, 5, 6.
- **Proposed severity:** medium.
- **Location:**
  - `interp/temporal.rs:12–19, 38–50` (kind 5 = `Calendar`).
  - `:158–179` (`temporal_plain_valid`: no ISO range check).
  - `:181–252` (`parse_temporal_plain`: `split('[')` drops annotations, `str::parse` accepts signs).
  - `:962–1019` (`parse_temporal_instant` requires seconds).
  - `interp/natives/temporal.rs:41–56` (`temporal_integer` rejects fractions), `:176–295` (`from` ignores `overflow`).
  - `ironhorse-262/expectations/whole-tree/built-ins%2FTemporal*.txt`.
- **Excerpt:**
  ```rust
  pub(super) fn parse_temporal_plain(kind: u8, text: &str) -> Option<TemporalPlainRecord> {
      let text = text.split('[').next()?;          // annotations, incl. critical `[!u-ca=...]`, ignored
      ...  r.month = p.next()?.parse().ok()?;      // accepts "+1"
  ```
- **Mechanism:**
  - The implementation follows an older proposal snapshot: `Temporal.Calendar` exists, and `era` is `'ce'` for `iso8601`.
  - It omits `overflow` (constrain is the default), `monthCode`, ToIntegerWithTruncation, the ISO date limits (−271821-04-19 to +275760-09-13), leap-second clamping and RFC 9557 annotation validation.
  - Field reads happen in year / month / day order. The spec reads alphabetically, and the order is observable.
  - No Temporal path charges the meter.
  - The whole-tree expectation lists are differential against XS, which has no Temporal: 8,316 cases are `skip:oracle-host-missing*` and the 890 `fail` entries are oracle artifacts. The gate therefore measures nothing here.
- **Scenario:** The following all deviate from the spec:
  - `PlainDate.from({year:2021,month:2,day:31})` gives TypeError (spec: 2021-02-28).
  - `PlainDate(300000,1,1)` is accepted.
  - `PlainDate.from('2021-01-01[!u-ca=hebrew]')` is accepted.
  - `Instant.from('2020-01-01T00:00Z')` gives RangeError.
  - `PlainTime.from('12:00:60')` gives RangeError (spec: 12:00:59).
  - `add({months:1},{overflow:'reject'})` from 01-31 returns 02-28.
  - `Instant.toZonedDateTimeISO` is missing ("call: not a function").
- **Evidence:** confirmed by probe (`tmp1.js` output listed above).
  - My plain-host test262 sweep (`t262run.py`: sloppy only, no async, no `$262`) over `built-ins/Temporal`: **2023 pass / 2580 fail of 4603**.
    | Type | Pass / total |
    |---|---|
    | Duration | 350/540 |
    | Instant | 216/465 |
    | PlainDate | 206/652 |
    | PlainDateTime | 237/773 |
    | PlainMonthDay | 76/199 |
    | PlainTime | 219/493 |
    | PlainYearMonth | 170/509 |
    | ZonedDateTime | 495/901 |
  - Top failure messages:
    - `missing or invalid required date/time fields`: 170 (e.g. `built-ins/Temporal/Duration/prototype/round/zero-duration.js`).
    - `Expected SameValue(«"ce"», «undefined»)`: 134 (`built-ins/Temporal/PlainDate/basic.js`).
    - `invalid date/time string`: 117 (`.../PlainDate/compare/argument-string-time-separators.js`).
    - `invalid instant string`: 71.
    - "reject minus zero as extended year": 44.
  - `intl402/Temporal`: 112/2029.
- **Recommendation:**
  - Either adopt `temporal_rs` (the Boa / V8 Rust implementation) behind the same record side tables, or gate `Temporal` off until it conforms.
  - In either case, run test262 Temporal and intl402 on the plain host in CI, since the oracle cannot see these.
  - Meter field arithmetic and parsing.
- **Confidence:** confirmed by probe and test262.

### NVAL-8 — The Intl "frozen profile" is a set of disagreeing hand tables: locales reported as supported are formatted with English data

- **Lens(es):** 6 (one concept, "supported locale", classified differently per table), 1, 3, 5.
- **Proposed severity:** medium.
- **Location:**
  - `interp/locale.rs:225–248` (`locale_is_supported`, 19 languages).
  - `:182–202` (`maximize_locale`, 10 languages, otherwise `Latn`/`US`).
  - `:272–298` (list patterns: en, plus es for the `unit` type).
  - `:816–901` (plural categories for 9 languages, selection rules for en/fr only).
  - `:466–677` (DTF parts: English only; minute `numeric` renders `"0"`).
  - `intl_number.rs:884–913` (comma-decimal set of 8 languages; fr grouping `.`).
  - `interp/text.rs:105–143` (case tailoring tr/az only).
  - `interp/natives/intl.rs:313–328` (`intl_resolve_locale` returns the requested tag unvalidated).
  - `intl.rs:55–85` (locale lists read `self.arrays` directly).
  - `boot.rs:2766–2768` (`Date.prototype.toLocale*String` = `toString`).
- **Excerpt:**
  ```rust
  // plural_select: "English cardinal and ordinal rules are modeled exactly; other locales use the English cardinal shape as an approximation."
  _ => { if i == 1 && v == 0 { "one" } else { "other" } }
  ```
- **Mechanism:**
  - `supportedLocalesOf` and ResolveLocale accept 19 languages.
  - Each formatter keys its own table on the language subtag and falls back to English silently.
  - `PluralRules('ar').resolvedOptions().pluralCategories` lists six categories, but `select` can only return `one` or `other`.
  - `CanonicalizeLocaleList` bypasses the MOP: it treats array-likes as a single string and ignores accessors and proxies.
- **Scenario:** All of these differ from Node (`exist1.js`):
  | Expression | IH | Node |
  |---|---|---|
  | `new Intl.PluralRules('ru').select(3)` | `other` | `few` |
  | `PluralRules('ar').select(0)` | `other` | `zero` |
  | `PluralRules('pl').select(5)` | `other` | `many` |
  | `ListFormat('de').format(['a','b','c'])` | `a, b, and c` | `a, b und c` |
  | `DateTimeFormat('de').format(0)` | `1/1/1970` | `1.1.1970` |
  | `DateTimeFormat('ja').format(0)` | `1/1/1970` | `1970/1/1` |
  | `NumberFormat('fr').format(1234567.891)` | `1.234.567,891` | `1 234 567,891` (NNBSP) |
  | `Locale('th').maximize()` | `th-Latn-US` | `th-Thai-TH` |
  | `Locale('el').maximize()` | `el-Latn-US` | `el-Grek-GR` |
  | `NumberFormat('xx').resolvedOptions().locale` | `xx` | `en-US` |
  | `Intl.getCanonicalLocales({length:1,0:'en'})` | RangeError | `['en']` |
  | `new Date(0).toLocaleDateString('de-DE')` | `Thu Jan 01 1970` | `1.1.1970` |
  | `DateTimeFormat('en-US',{hour:'numeric',minute:'numeric'})` | `7:0 AM` | `8:00 AM` |
- **Evidence:**
  - Confirmed by probe (`exist1.js`, `tz1.js`, `date1.js`).
  - test262 plain host `intl402`: **785 / 3357 pass**.
    | Directory | Pass / total |
    |---|---|
    | Locale | 65/168 |
    | DateTimeFormat | 122/244 |
    | NumberFormat | 166/249 |
    | DisplayNames | 4/57 |
    | RelativeTimeFormat | 0/80 |
    | DurationFormat | 0/110 |
  - Failing examples: `intl402/supportedLocalesOf-locales-arg-coered-to-object.js` and `intl402/language-tags-canonicalized.js`.
- **Recommendation:**
  - Make `locale_is_supported` the single source of truth, and have every table consult it.
  - Either carry real CLDR data for each advertised locale (ICU4X `icu_plurals`, `icu_list`, `icu_datetime`, `icu_decimal` under the same lock), or shrink the advertised set to `en`.
  - Implement CanonicalizeLocaleList with ToObject, `length` and Get.
  - Route `Date.prototype.toLocale*String` through DateTimeFormat as ECMA-402 requires.
- **Confidence:** confirmed by probe.

### NVAL-9 — The same "too large" or "not modeled" condition is classified four different ways; several are uncatchable halts where engines throw RangeError

- **Lens(es):** 6 (taxonomy not consistent), 3, 1.
- **Proposed severity:** medium.
- **Location:**
  - `Halt::Refused` (uncatchable):
    - `string.rs:148–151` (`String.raw` > 2^24 segments) and `:741–746` (`padStart` / `padEnd` > 2^24).
    - `natives/bigint.rs:264–265, 338–349, 638–640` (`asIntN`, `**`, `<<` > 64 Ki bits).
    - `json.rs:664–667, 1045–1046` (lengths > u32).
  - Catchable RangeError: `string.rs:603–608` (`repeat` count > 2^31-1) and `admission.rs:128–130` (`reserve_units` "result too large").
  - `Halt::NotImplemented`: `natives/dispatch.rs:3152–3154` (`NumberFormat.formatRange`), `intl.rs:1316–1319` (compact non-en), `natives/temporal.rs:1780–1782` (`ZonedDateTime.toLocaleString`, although Intl exists).
  - Catchable "unsupported" RangeError: `natives/temporal.rs:120, 195, 1166, 1756, 1766`; `intl.rs:454`.
  - Silent approximation: NVAL-8.
- **Excerpt:**
  ```rust
  // intl.rs:1298-1303 — the stated doctrine:
  // A `Halt::NotImplemented`, NOT a catchable error. ... a `RangeError` here would be a fabricated
  // spec-shaped error that a guest cannot tell from "you passed an invalid option".
  // temporal.rs / intl.rs:454 — the opposite, for the same kind of gap:
  self.catchable_range_error_msg("Intl.DateTimeFormat: invalid or unsupported timeZone".into())
  ```
- **Mechanism:** No single rule decides whether a resource limit or a profile gap is:
  - a catchable spec-shaped error,
  - an uncatchable crank-killing halt, or
  - a silently wrong value.

  The `intl.rs` comment states the doctrine and admits that the file breaks it. Temporal does the opposite. `padStart` and `repeat` take different paths for the same resource condition.
- **Scenario:** All of these kill the crank uncatchably, so a guest cannot defend with `try`:
  - `try { 'abc'.padStart(2**53) } catch {}` (Node: RangeError)
  - `10n ** 20000n` (Node: a value)
  - `new Intl.NumberFormat('en').formatRange(1,5)` (Node: `'1–5'`)

  Meanwhile `new Intl.DateTimeFormat('en',{timeZone:'Europe/Kyiv'})` is presented as invalid input.
- **Evidence:** confirmed by probe:
  - `str1.js`: `InternalError: ironhorse halted: Refused("String.prototype.pad:result-too-large")`.
  - `big3.js`: `Refused("exponentiation:result-too-large")`.
  - `exist1.js`: `NotImplemented("Intl.NumberFormat:formatRange")`.
  - `tz1.js`: RangeError for `Europe/Kyiv`.
- **Recommendation:**
  - Define one taxonomy in `halt_labels.rs`:
    - Implementation size limits become catchable RangeErrors through `reserve_units`, as `repeat` already does.
    - Unmodeled spec features become `NotImplemented` everywhere, including Temporal calendars and zones.
    - Silent approximation is never allowed.
  - Add a test that each label is used with exactly one class.
- **Confidence:** confirmed by probe.

### NVAL-10 — `JSON.parse` accepts `\u+XYZ` escapes

- **Lens(es):** 1.
- **Proposed severity:** medium (accepts invalid JSON; differs from every engine).
- **Location:** `ironhorse-vm/src/interp/natives/json.rs:1589–1591`.
- **Excerpt:**
  ```rust
  let hex = match std::str::from_utf8(&input[i + 1..i + 5]).ok()
      .and_then(|h| u32::from_str_radix(h, 16).ok())   // Rust accepts a leading '+'
  ```
- **Mechanism:** `u32::from_str_radix` accepts an optional `+` sign, so `\u+041` decodes to `A`. The same parser serves `JSON.rawJSON`.
- **Scenario:** A validator that relies on `JSON.parse` to reject malformed input lets `"\u+041"` through. The two engines disagree.
- **Evidence:** confirmed by probe (`json1.js`).
  - `JSON.parse('"\\u+041"')`: IH `'A'`, Node SyntaxError.
  - `JSON.rawJSON('"\\u+041"')` is accepted by IH (the later TypeError comes from `String()` of a null-prototype object); Node throws SyntaxError.
- **Recommendation:** Require four `is_ascii_hexdigit` bytes before converting, and add a regression case.
- **Confidence:** confirmed by probe.

### NVAL-11 — `parseInt`, and `Number()` on `0x` / `0o` / `0b` strings, double-round by accumulating digits in f64

- **Lens(es):** 1.
- **Proposed severity:** medium.
- **Location:** `ironhorse-vm/src/interp/numeric.rs:85–112` (`parse_int`), `:234–242` (non-decimal `string_to_number`).
- **Excerpt:**
  ```rust
  result = result * radix as f64 + digit as f64;        // parse_int
  acc = acc * r as f64 + d;                              // string_to_number 0x/0o/0b
  ```
- **Mechanism:**
  - Each step rounds once beyond 2^53, so the final result can be off by one ULP or more.
  - ECMA-262 `parseInt` requires the correctly rounded value for radix 2, 4, 8, 16 and 32, and for up to 20 significant decimal digits. `StringToNumber` requires exact MV rounding.
  - Decimal `Number()` is correct because it goes through Rust's `f64` parse.
- **Scenario:** `parseInt` of a 17-digit ID or timestamp-like string, and hex constants above 2^53, give values that differ from every engine.
- **Evidence:** confirmed by probe (`math1.js`, `parse2.js`, `dblround.js` vs Node):
  | Expression | IH | Node |
  |---|---|---|
  | `parseInt('48835871506362344')` | `48835871506362340` | `48835871506362344` |
  | `parseInt('64503382158868181')` | `...180` | `...184` |
  | `parseInt('1000000000000081',16)` | `1152921504606847000` | `1152921504606847200` |
  | `Number('0x1000000000000081')` | `1152921504606847000` | `1152921504606847200` |
  | `parseInt('12345678901234567891')` | `12345678901234570000` | `12345678901234567000` |
  | `parseInt('123456789012345678901234567890')` | `1.2345678901234566e+29` | `1.2345678901234568e+29` |
- **Recommendation:**
  - For power-of-two radices, accumulate exact bits (u128, or the most significant 54 bits plus a sticky bit) and round once.
  - For radix 10, truncate to 20 digits and use Rust's `f64` parse.
  - Elsewhere, accumulate in u64 until overflow, then fall back to BigInt-style exact conversion.
- **Confidence:** confirmed by probe.

### NVAL-12 — `Math.fround`, `Math.hypot` (three or more args) and `Math.round` return wrong values on reachable inputs

- **Lens(es):** 1, 6 (`Kind::Integer` treated as "already representable" for f32).
- **Proposed severity:** medium.
- **Location:** `ironhorse-vm/src/interp/natives/number.rs:148–152` (`fround`), `:82–94` (`hypot`), `:116–132` (`round`).
- **Excerpt:**
  ```rust
  Fround => match ... { Some(s) if s.kind == Kind::Integer => s, ...         // i32 is not exact in f32
  _ => vals.iter().map(|x| x * x).sum::<f64>().sqrt(),                        // hypot, >=3 args
  if a.is_normal() && (-4503599627370495.0 < a) && (a < 4503599627370495.0) { a = (a + 0.5).floor() }  // round
  ```
- **Mechanism:**
  - The `fround` integer fast path skips the f32 rounding.
  - `hypot` with three or more arguments uses a naive sum of squares, so it overflows and underflows. It also ignores the spec rule that any ±Infinity argument wins over NaN.
  - `round` leaves x.5 values in [2^51, 2^52) unrounded, because the window excludes them and they are not integers.
- **Scenario:** `Math.fround(16777217)` is used for f32 emulation; `Math.hypot(x,y,z)` is used for vector length with large or small coordinates.
- **Evidence:** confirmed by probe (`math1.js` vs Node):
  | Expression | IH | Node |
  |---|---|---|
  | `Math.fround(16777217)` | `16777217` | `16777216` |
  | `Math.fround(2147483647)` | `2147483647` | `2147483648` |
  | `Math.hypot(1e200,1e200,1e200)` | `Infinity` | `1.7320508075688773e+200` |
  | `Math.hypot(1e-200 ×3)` | `0` | `1.73e-200` |
  | `Math.hypot(NaN,Infinity,1)` | `NaN` | `Infinity` |
  | `Math.round(4503599627370495.5)` | `4503599627370495.5` | `4503599627370496` |
  | `Math.round(-4503599627370495.5)` | `-4503599627370495.5` | `-4503599627370495` |

  test262 `built-ins/Math` passes 322/327 (the failures are `random` and cross-realm), so these paths are untested.
- **Recommendation:**
  - Drop the `fround` integer fast path.
  - Implement `hypot` per spec: Infinity check first, then scale by the maximum magnitude.
  - Use `if a.fract() == 0 { a } else { (a + 0.5).floor() }`, or the spec's `floor(x + 0.5)` with exactness guards, over the full range.
- **Confidence:** confirmed by probe.

### NVAL-13 — JSON nesting deeper than about 2048 levels is an uncatchable halt, and stringify re-copies output once per nesting level

- **Lens(es):** 3, 4, 1.
- **Proposed severity:** medium.
- **Location:** `ironhorse-vm/src/interp/natives/json.rs:1323–1331` (parse), `:828–840` (stringify), `:1213–1251` (copy at close), `interp.rs:409` (`NATIVE_DEPTH_LIMIT = 2048`).
- **Excerpt:**
  ```rust
  'value: loop { self.enter_native_frame(LIGHT_FRAME_COST)?;   // ReentryLimit halt at 2048, though the stack is a heap Vec
  ...
  out.extend_from_slice(part);   // json_stringify_close: every child's units copied into the parent
  ```
- **Mechanism:**
  - Since the STACK-DEPTH refactor, parse and stringify use heap stacks. They still charge the shared native-recursion budget per level and fail with `Halt::ReentryLimit`, which is not catchable.
  - Stringify materializes each level's text and copies it into the parent. A payload at depth d is therefore copied d times. Only punctuation is charged per level.
- **Scenario:**
  - `JSON.parse(untrustedText)` with 3000 nested brackets kills the crank. Node parses it.
  - A large string nested 2000 deep costs about 20× more host time per computron than a flat one.
- **Evidence:** confirmed by probe.
  - `deep1.js` / `deep2.js`: IH `InternalError: ironhorse halted: ReentryLimit { depth: 2049, limit: 2048 }`; Node `[true,true]` and `[6002]`.
  - Rust probe: `json-deep` (1 MiB string inside 2000 arrays) `computrons=330744 ms=583.4` (567/ms), against `json-shallow` `computrons=262233 ms=27.6` (9496/ms).
- **Recommendation:**
  - Give JSON its own depth budget with a catchable RangeError, or no budget, since the stack is heap-allocated and admitted.
  - Serialize stringify into one output buffer with back-patching instead of per-level `Vec`s.
- **Confidence:** confirmed by probe.

### NVAL-14 — `Date.parse` accepts conforming ISO strings with illegal field values

- **Lens(es):** 1.
- **Proposed severity:** low.
- **Location:** `ironhorse-vm/src/interp/date.rs:98–103, 204–316` (`parse_xs_legacy_iso_string`, kept for XS parity), `:181–202` (`parse_date_clock` accepts 1-digit and signed fields).
- **Excerpt:**
  ```rust
  /// ... the fallback normalizes out-of-range calendar/clock fields, truncates
  /// excess fractional-second digits, and accepts an hours-only zone offset.
  ```
- **Mechanism:** ECMA-262 21.4.3.2 requires NaN for "dates containing illegal element values in the format String". The fallback re-parses the same Date Time String Format and normalizes those values instead.
- **Scenario:** Validation by `isNaN(Date.parse(s))` accepts `2020-13-01` (it becomes 2021-01-01).
- **Evidence:** confirmed by probe (`date1.js`, TZ=UTC). Each of these returns NaN in Node but a number in IH:
  - `2020-01-01T24:00:00.001`
  - `2020-01-01T10:00:60`
  - `2020-13-01`
  - `2020-00-10`
  - `2020-01-01T1:00Z`

  In the other direction, common non-ISO forms that Node accepts are NaN in IH (implementation-defined): `2020-01-01 10:00:00`, `Jan 1, 2020`, `1/2/2020`, and Node's own `toString` output with its `(Coordinated Universal Time)` suffix.
- **Recommendation:** Run the legacy fallback only when the strict parser *rejected the grammar*, not when it rejected the values. Also consider accepting the space-separated date-time form.
- **Confidence:** confirmed by probe.

### NVAL-15 — `JSON.stringify` replacer-array dedupe is O(n²) and unmetered

- **Lens(es):** 4, 1.
- **Proposed severity:** low.
- **Location:** `ironhorse-vm/src/interp/natives/json.rs:708–713`.
- **Excerpt:** `if property_list.iter().any(|existing: &JsonPropertyName| existing.units == units) { continue; }`
- **Mechanism:** Each new key scans every key already in the list.
- **Scenario:** `JSON.stringify(obj, keysArray)` with tens of thousands of keys.
- **Evidence:** confirmed by probe. With numeric replacer arrays, `JSON.stringify({}, k)` took 0.51 / 0.79 / 3.76 s for 10k / 20k / 40k keys; Node took 0.12 s at 40k. The Rust probe `json-replacer` (10k string keys) gave `computrons=297065 ms=3502.1`.
- **Recommendation:** Dedupe with a `HashSet<Vec<u16>>` (iteration order still comes from the Vec), and charge per key.
- **Confidence:** confirmed by probe.

### NVAL-16 — `String.fromCharCode` ToUint16 saturates for |n| ≥ 2^63

- **Lens(es):** 1, 2.
- **Proposed severity:** low.
- **Location:** `ironhorse-vm/src/interp/natives/string.rs:73–80`.
- **Excerpt:** `n.trunc() as i64` then `integer.rem_euclid(0x1_0000) as u16`.
- **Mechanism:** `as i64` saturates, so 2^63 or 2^64 becomes `i64::MAX`, giving 0xFFFF where ToUint16 gives 0.
- **Scenario:** Edge coercions; a fuzzer or differential test would flag these.
- **Evidence:** confirmed by probe (`fcc.js` vs Node).
  | Expression | IH | Node |
  |---|---|---|
  | `String.fromCharCode(2**63)` | 65535 | 0 |
  | `String.fromCharCode(2**64+2**20)` | 65535 | 0 |
  | `String.fromCharCode(-(2**63)-2**12)` | 0 | 61440 |
  | `String.fromCharCode(1e300)` | 65535 | 0 |
- **Recommendation:** Reuse `numeric::number_to_u64_wrapping` (`numeric.rs:512`), which already does modular conversion for typed arrays.
- **Confidence:** confirmed by probe.

### NVAL-17 — The empty string is not interned: every empty result appends an unmetered 4-byte chunk, contrary to the doc comment

- **Lens(es):** 4, 6 (docs and code disagree).
- **Proposed severity:** low.
- **Location:** `ironhorse-vm/src/interp/strings.rs:113–118`; `value.rs:2506–2586` (no zero-length fast path).
- **Excerpt:**
  ```rust
  if units.is_empty() {
      // XS's `mxEmptyString` — an interned "", no metered fxNewChunk.
      let off = self.chunks.alloc(&[]);
  ```
- **Mechanism:** `alloc(&[])` writes a fresh 4-byte header each time. With no intra-crank GC, every `''` result (`slice(n,n)`, `charAt(oob)`, `trim` of whitespace, `toWellFormed('')`, ...) permanently consumes 4 bytes of the ceiling for the rest of the crank, with no computron charge.
- **Scenario:** A loop that produces empty strings leaks against the ceiling. Snapshots carry the dead chunks until the next collection.
- **Evidence:** static, `value.rs:2556–2586` appends unconditionally. Not measured.
- **Recommendation:** Keep one canonical empty-string chunk offset as a GC root (as `typeof` atoms are) and return it.
- **Confidence:** high.

## Duplication inventory

| Family | Copies (path:line) | Size | Notes |
|---|---|---|---|
| Exact decimal expansion of an f64 via `format!("{x:.1100}")` | `interp/numeric.rs:604–620` (`exact_decimal`); `intl_number.rs:241–278` (`Decimal::from_f64`) | ~17 + ~38 lines | Same algorithm, different output shape |
| Digit rounding for number formatting | `numeric.rs:625–676` (`scaled_round`, `significant_digits`: half-up only); `intl_number.rs:312–454, 467–532` (`round_to_significant`, `to_raw_fixed`: nine modes) | ~50 + ~200 | `toFixed` / `toPrecision` are `ToRawFixed` / `ToRawPrecision` with `halfExpand` |
| ECMA rounding modes | `intl_number.rs:391–440` (enum, digit-based); `temporal.rs:720–781` (f64, string names); `temporal.rs:1308–1373` (i128, string names); `temporal.rs:783–791` (`round_half_expand`) | ~50 + 62 + 66 + 9 | Four implementations of one 9-mode table; two use `&str` mode names with different fallbacks (`_ => halfExpand` vs `None`) |
| Civil date from day number (Hinnant) | `interp/date.rs:9–34` (`civil_fields`, inlined); `interp/temporal.rs:948–960` (`civil_from_days`) | 26 + 13 | `days_from_civil` is shared; the inverse is not |
| ISO date / time text parsers | `date.rs:109–179` (strict); `date.rs:209–292` (XS legacy: near-verbatim copy of the strict parser, including the offset block at 141–167 and 252–280); `date.rs:181–202` vs `:294–316` (clock parsers); `temporal.rs:181–252` (plain), `:962–1019` (instant), `:1103–1151` (offset), `:1179+` (zoned), `:1425–1446` (numeric zone) | ~550 lines total | Seven-plus parsers with different laxness. All use `str::parse` (accepting `+1`); offset grammars differ (`±HH` is accepted by the legacy parser and the zone table, rejected by the strict one) |
| BigInt decimal rendering | `interp/bigint.rs:351–378` (`bi_to_decimal`, base 10^9, unmetered); `interp.rs:3672–3708` (`bi_to_radix`, per-digit, metered) | 28 + 37 | 13× speed difference and opposite metering (NVAL-2) |
| StringIntegerLiteral prefix and sign parsing | `interp/bigint.rs:382–423` (`parse_bigint_string_u64`); `:428–474` (`parse_bigint_string`) | ~30 duplicated lines | The u64 form is the full parse modulo 2^64 |
| Temporal property-bag field reads | `natives/temporal.rs:208–276` (`from`); `:333–408` (`with`) | 69 + 76 | Identical nine-arm `match n` with u32 range errors |
| Locale language extraction | `interp/locale.rs:259–265`; `intl_number.rs:916–922` (same name, fallback `"en"` vs `""`); `interp/text.rs:114` (inline split) | — | Plus 8 independent "supported locale" tables (NVAL-8) |
| Offset rendering | `locale.rs:445–463` (`GMT±H[:MM]`); `temporal.rs:1081–1099` (`±HH:MM[:SS[.f]]`) | — | Different grammars for the same concept |
| Fraction zero-padding `format!("{frac:0<9}")` / `"{:0<3}"` | `date.rs:199, 313`; `temporal.rs:243, 994, 1148` | — | Trivial, but each copy re-validates digits differently |
| Getter dispatch tables | `dispatch/property_read.rs:44–298` (by key text) vs the boot prototype tables | — | Parallel name lists maintained by hand (NVAL-4) |
| Date op numbering | `boot.rs:2734–2790` (name → u8) vs `natives/date.rs:19–237` (u8 → behaviour) | 37 ops | Parallel numeric tables; Temporal Plain / Zoned / Now do the same |

## Skipped features and refusals inventory

| Site | What is refused or skipped | Spec status | Should support? | Effort |
|---|---|---|---|---|
| `natives/date.rs:50`; Temporal.Now (`natives/temporal.rs` ~1880–1914) | `Date.now()` = 0; `new Date()` = epoch; `Temporal.Now.*` = epoch and `UTC` | Required (host time) | Deliberate for determinism. Better: a host-supplied, metered clock capability, or a documented throw | S (host hook) |
| Boot (no `random` on Math) | `Math.random` absent | Required | Yes (seeded deterministic PRNG from host); test262 `built-ins/Math/random/*` (4 fail) | S |
| `boot.rs:2766–2768` | `Date.prototype.toLocale{,Date,Time}String` = `toString` forms, ignoring locales and options | ECMA-402 §20.4 | Yes (route via DTF) | S |
| `natives/dispatch.rs:3152` | `Intl.NumberFormat.prototype.formatRange` / `formatRangeToParts`: `NotImplemented` halt | ES2023-402 | Yes; 11 intl402 tests | M |
| `intl.rs:1316` | `notation:'compact'` for non-en: `NotImplemented` halt | ECMA-402 | Yes, with CLDR data | M |
| Boot (absent) | `Intl.RelativeTimeFormat`, `Intl.DisplayNames`, `Intl.DurationFormat` | ECMA-402 (DurationFormat ES2025) | Yes for RTF and DisplayNames (80 + 57 tests) | M–L |
| `natives/temporal.rs:1780` | `ZonedDateTime.toLocaleString`: `NotImplemented` "needs-intl" (Intl exists) | Temporal | Yes | S |
| `natives/temporal.rs:435` | `Plain*.until` / `since` for non-ISO calendar: `NotImplemented` | Temporal | Only with real calendars | L |
| `natives/temporal.rs:120, 195, 1766` | Any calendar except `iso8601`: catchable RangeError | Temporal + 402 | Yes (ICU4X `icu_calendar`) | L |
| `temporal.rs:1463–1487`; `intl.rs:454` | Named time zones beyond 23; DST everywhere | Required for correctness | Yes (tzdb snapshot) | M |
| `Date.prototype.toTemporalInstant` | Absent (7 test262 fails) | Temporal | Yes | S |
| `string.rs:741–746` | `padStart` / `padEnd` > 2^24 units: `Refused` halt | Implementation limit | Make it a catchable RangeError via `reserve_units` | XS |
| `string.rs:148–151` | `String.raw` > 2^24 segments: `Refused` | Implementation limit | Same | XS |
| `natives/bigint.rs:233–265, 308–349, 628–640` | `asIntN` / `asUintN`, `**`, `<<` results > 64 Ki bits: `Refused` | Implementation limit | RangeError, consistent with `*` (NVAL-2) | S |
| `json.rs:664–667, 1045–1046` | Replacer or array-like length > u32: `Refused` | Implementation limit | RangeError | XS |
| `json.rs:1331`, `interp.rs:409` | JSON depth > ~2048: `ReentryLimit` halt | Implementation limit | Catchable RangeError or no limit (NVAL-13) | S |
| `text.rs:114–117` | Locale case tailoring only for tr/az (not lt) | ECMA-402 `toLocale{Upper,Lower}Case` | Yes (`icu_casemap`) | S |
| `locale.rs:903` | Collation not UCA (NVAL-5) | ECMA-402 | Yes (`icu_collator`) | M |
| `locale.rs:816–901` | Plural rules only en/fr; others silently en | ECMA-402 | Yes (`icu_plurals`) | S |
| `locale.rs:466–677` | DTF only en patterns; calendar / numberingSystem options accepted and ignored | ECMA-402 | Yes (`icu_datetime`) | L |
| `natives/number.rs:438–443` | Comment claims fractional non-decimal radix `toString` is "an honest named skip"; it is implemented (probe matches Node) | — | Fix the comment | XS |

## Memory and performance opportunities

| Site | Waste | Magnitude | Fix |
|---|---|---|---|
| `strings.rs:130–142` (`concat_add`) | 4 full copies and 3 heap `Vec`s per `+`; result never reclaimed within a crank | O(n²) bytes for append loops; heap exhausted at ~15–18k appends (NVAL-3); 331 computrons/ms | Concatenate stored BE16 payloads directly (1 copy); rope or tail-append |
| `string.rs:30–45, 567` (`string_this_units`) | Every non-indexed String method decodes the receiver to a `Vec<u16>` (2n bytes) even when it only reads: `trim`, `isWellFormed`, `padStart` with short target, `normalize` | 1 extra full copy per call | Operate on the stored payload (as the indexed methods already do) |
| `string.rs:766–795` | `isWellFormed` allocates the `toWellFormed` output buffer too | 2n bytes per call | Separate the two paths |
| `natives/bigint.rs:75–96, 387–397` | Every BigInt op decodes operands into `Vec<u32>`s and re-encodes results through a temporary `Vec<u8>` | 3+ allocations per op even for 1-limb values; `===` and `truthy` decode too (`coerce.rs:239–243, 428–431`) | Compare and test payload bytes directly (format is canonical: trimmed limbs, sign normalized); small-BigInt fast path |
| `interp/bigint.rs:118–153` | Bit-serial long division with an allocation per subtract | ~150× slower than Knuth D (1.74 s for 8125/2000 limbs) | Algorithm D |
| `json.rs:515–526` | Parse input copied twice (UTF-16 `Vec`, then WTF-8 `Vec`, admitted at 3×) | Up to 5n bytes transient | Tokenize the BE16 payload in place |
| `json.rs:1213–1251` | Stringify materializes each container and copies it into the parent | O(output × depth) copying (NVAL-13) | Single output buffer |
| `property_read.rs:48, 58, 78, 134` | `scalar_key_text(id)` allocates a `String` on every property read of a Temporal object (including method lookups like `d.add`) | 1 allocation per access | Compare interned ids |
| `natives/dispatch.rs:2839`; `property_read.rs:289–292` | `CollatorData` (5 `String`s) cloned per `compare`; `collator_compare_functions` searched linearly per `.compare` read | O(#collators) per access; 5 allocations per compare | Store an `Rc` / record id; reverse map |
| `intl_data.rs:19–60` | Intl option records as `String`s (usage, sensitivity, caseFirst, kind, style, roundingType, ...) re-parsed into enums by `nf_resolved` on every `format` | Tens of bytes and a string match per field per call | Store enums (as `intl_number.rs` already defines) |
| Binary: ICU4X segmenter compiled data | `WordSegmenter::new_auto` (`locale.rs:320`) links the CJ dictionary | Measured 2,007,110 bytes (one `.rodata` symbol at 0xfcc50, byte-matched to `segmenter_dictionary_auto_v1`) of the 8,833,008-byte `ironhorse-xst`; plus the LSTM model (875 KB of source text). `WASM-BLOCKERS.md:1173` reports a 6.9 MB module "including ICU normalizer and segmenter data" | Use `WordSegmenter::new_for_non_complex_scripts` (or make dictionary/LSTM a feature) unless CJK or Thai word breaking is a requirement |
| `string.rs:118` / `value.rs:2506` | Empty strings allocate a chunk each time (NVAL-17) | 4 B per empty result, unreclaimed for the crank | Interned empty chunk |
| `natives/number.rs:383–437`, `numeric.rs:607` | `toFixed` / `toPrecision` format 1,100+ characters for every call | ~1.2 KB temporary per call | Use exact shortest digits plus big-decimal only when needed (Ryu printf) |

## Ontology notes

- **"Metered" is a homonym.** `new_string_metered` / `new_string_units` mean "ticked, never checked" (`strings.rs:103–122`). `alloc_str_text_metered` means "charged and checked" (`strings.rs:84–95`). `to_string_units_metered` means "ticks the render only". `alloc_str_text` is documented "Unmetered". `new_reserved_string_units` means "prepaid elsewhere". A call site cannot tell from the name whether a host check point occurs, which is how NVAL-1 / NVAL-2-style holes stay invisible. Suggested split: `tick_*` (accrue), `admit_*` (heap only), `charge_*` (accrue and check), and alloc helpers named for which of these they do.
- **"Unsupported" taxonomy** is not exhaustive or disjoint (NVAL-9). Four classes:
  - uncatchable `Refused` / `NotImplemented` halts;
  - catchable spec-shaped RangeError ("unsupported calendar / time zone");
  - catchable RangeError for sizes (`repeat`, `reserve_units`);
  - silent approximation (Intl locale data).

  The same condition gets a different class at different sites.
- **"Supported locale"** is defined eight times (NVAL-8): `locale_is_supported`, `maximize_locale`, `list_patterns`, `plural_categories`, `plural_select`, `locale_uses_comma_decimal`, `compact_locale_is_modeled`, `unicode_locale_case_convert_utf16`. The guest-observable `supportedLocalesOf` answer agrees with none of the data tables.
- **Getters are not properties** (NVAL-4). For Temporal / Intl, the "property" exists only as a name match in the opcode, not in the object model, so the MOP and the opcode disagree. This is a guest-observable divergence from ECMA-262 ordinary-object semantics.
- **`Kind::Integer` is overloaded.** It means "an i32-representable Number", but `Math.fround` and `Math.round` read it as "needs no rounding" (NVAL-12). A representation tag is being used as a semantic predicate.
- **Untyped op codes:**
  - `NativeMethod::Date(u8)`, `TemporalPlain(u8, u8)`, `TemporalZoned(u8)` and `TemporalNow(u8)` carry bare u8 op numbers whose meaning lives in two hand-synced tables (boot names vs match arms).
  - `TemporalPlainRecord.kind: u8` (0–5) mixes value types with the obsolete `Calendar` (kind 5).
  - Temporal Instant and Duration use named variants. The two encodings coexist for the same kind of thing.
- **Option enums are typed in one module and stringly typed in another.** Rounding mode is `RoundingMode` in `intl_number.rs:128`, but `String` in `PluralRulesData.rounding_mode` (`intl_data.rs:56`) and `&str` in `temporal.rs:720, 1308`. The sets are the same nine names.
- **Date local time** is defined as UTC (offset 0), consistently across `getTimezoneOffset`, `getX` / `getUTCX` sharing ops, and DTF's default zone. It is consistent but undocumented as a profile decision in ARCHITECTURE.md. `Date.now()` = 0 is likewise a silent profile choice.
- **Docs disagree with code in four places:**
  - `strings.rs:115` "interned" empty string (it is not; NVAL-17);
  - `number.rs:438–443` (non-decimal radix "named skip", though implemented);
  - `coerce.rs:436–442` and `:537–543` ("a string operand ... returns `Err` and the caller self-names unsupported", though `ToNumber(string)` is implemented);
  - `string.rs:216–225` (two doc comments fused).
- **The test262 coverage class "skip: oracle-host-missing"** conflates "IronHorse does not implement X" with "the oracle cannot judge X". For Temporal and Intl the latter applies: the surface is implemented, and the plain host shows 44% and 23% pass rates. The expectation lists nevertheless classify it as skip or fail.

## Leads that did not survive

- **Number formatting:** `toFixed`, `toPrecision`, `toExponential`, radix `toString` (including fractional values, `Math.PI.toString(36)`, `MAX_VALUE` base 36), `-0`, `1e21` and range errors all match Node (`num1.js`: 36/36 values identical; only error message texts differ).
- **`Number()` / `parseFloat` / unary `+` over 49 tricky inputs:** numeric separators, `0x`, signed hex, `Infinity` spellings, U+FEFF / U+180E / U+0085 / U+2028 whitespace, denormal boundaries, 400-digit literals, `1n`, Arabic digits. All 196 results match Node (`parse1.js`). Only `parseInt` and non-decimal accumulation are wrong (NVAL-11).
- JSON stringify of lone surrogates, `toJSON`, wrappers, BigInt `toJSON`, gaps (string and number), replacer arrays with Number / String wrappers, `rawJSON` / `isRawJSON`, `__proto__` keys, duplicate keys, reviver `context.source` and property order all match Node (`json1.js`: 38/40). The plain-host `built-ins/JSON` test262 result is 163/165; both failures are cross-realm `$262`.
- `String.prototype.normalize` uses ICU4X and preserves lone surrogates. `toWellFormed`, `isWellFormed`, `at`, `fromCodePoint` range errors, `String.raw`, `substr`, `lastIndexOf(NaN)`, `replaceAll('')` and the trim whitespace set all match Node. `built-ins/String` is 1218/1223 on the plain host.
- `Math.sumPrecise` uses an exact 35-limb fixed-point accumulator with correct ties-to-even and -0 handling; unit tests and probes agree.
- BigInt `asIntN` / `asUintN` / bitwise / shift semantics: `built-ins/BigInt` is 76/77 on the plain host (1 cross-realm).
- URI encode / decode are linear, charged per unit and spec-correct. The 20 s test262 timeout (`S15.1.3.2_A2.5_T1.js`, Node 0.32 s) comes from general interpreter cost: decodeURIComponent itself is about 2.5 µs per call (`uri_bench1.js`: 0.50 s for 200k calls vs a 0.17 s loop baseline).
- Uint8Array base64 / hex: charged per unit, heap admitted; `built-ins/Uint8Array` 68/70 (both failures are the immutable-ArrayBuffer harness).
- Nondeterminism: no HashMap iteration feeds an output in these files (the HashMaps are lookups only; locale extensions use a `BTreeMap`). Number rendering uses Rust's deterministic formatting. Math transcendental functions are platform libm unless `deterministic-math` (enabled by `consensus`). The time sources are the constant 0.
- Host panics: fuzz-style probe `panic1.js` (multibyte, huge and garbage inputs across 11 Temporal / Date / Intl parsers, plus nine extreme Temporal arithmetic calls) produced only catchable errors, no panic. The slicing in `date.rs` / `temporal.rs` parsers is on verified ASCII boundaries.
- Date range edges: ±8.64e15 clipping, `+275760-09-13T00:00:00.000Z` / `.001Z`, `-271821-04-20`, `MakeDay` month normalization via i128, `setFullYear` on an invalid date, and `setYear` all match Node.
- JSON.parse with 20,000 distinct keys is fast (0.25 s). The slow case I hit (`o[k[i]] = 1` for 20,000 distinct computed names: 5.6 s vs Node 0.17 s, `rep_d.js`) is in property storage or interning, outside this region; passed on as a lead for the property-model reviewer.

---

### Probe appendix

Probe sources and raw outputs are in `../probes/vm-natives-values/`:
- JS probes: `*.js`, with `*.ih` / `*.node` outputs.
- `run.sh`: an IronHorse vs Node differ.
- `t262run.py`: the plain-host test262 runner; per-file results in `t262/*.json`.
- `zz_audit_nval_1.rs`, `zz_audit_nval_2.rs`: copies of the deleted Rust probes.

Rust probe 1 (`ironhorse-vm/tests/zz_audit_nval_1.rs`, deleted after the run; release build, `CARGO_TARGET_DIR=$SCRATCH/audit-target`):

```rust
use ironhorse_vm::Interp; use std::time::Instant;
fn run(label: &str, src: &str) {
    let (b, s) = ironhorse_compile::compile_atoms(src).expect("compiles");
    let names = ironhorse_vm::parse_symbols(&s);
    let mut m = Interp::new(); m.link_intrinsics(&names);
    let t = Instant::now(); let out = m.run(&b); let ms = t.elapsed().as_secs_f64() * 1e3;
    println!("{label:<14} completed={} computrons={:>12} ms={:>9.1} computrons/ms={:>10.1} halt={:?}",
        out.completed, out.computrons, ms, out.computrons as f64 / ms.max(0.001),
        if out.completed { None } else { Some(&out.halt) });
}
#[test] fn nval_metering_ratios() {
    run("baseline-loop", "var x = 0; for (var i = 0; i < 3000000; i++) { x = (x + i) | 0; } x");
    run("baseline-str", "var n = 0; for (var i = 0; i < 300000; i++) { n += ('ab' + i).length; } n");
    run("bigint-mul", "var x = (1n << 65000n) - 1n; for (var i = 0; i < 5; i++) x = x * x; x > 0n");
    run("bigint-div", "var x = (1n << 65000n) - 1n; x = x * x * x * x; var y = (1n << 64000n) + 12345n; (x / y) > 0n");
    run("String(big)", "var x = (1n << 65000n) - 1n; x = x * x * x * x; String(x).length");
    run("big.toString", "var x = (1n << 65000n) - 1n; x = x * x * x * x; x.toString().length");
    run("BigInt(str)", "var s = '7'.repeat(200000); BigInt(s) > 0n");
    run("1n<str", "var s = '7'.repeat(200000); 1n < s");
    run("includes", "var h = 'a'.repeat(40000); var n = 'a'.repeat(20000) + 'b'; h.includes(n)");
    run("indexOf", "var h = 'a'.repeat(40000); var n = 'a'.repeat(20000) + 'b'; h.indexOf(n)");
    run("json-replacer", "var k = []; for (var i = 0; i < 10000; i++) k.push('k' + i); JSON.stringify({}, k)");
    run("json-deep", "var v = 'x'.repeat(1 << 20); for (var i = 0; i < 2000; i++) v = [v]; JSON.stringify(v).length");
    run("json-shallow", "var v = 'x'.repeat(1 << 20); v = [v]; JSON.stringify(v).length");
    run("localeCompare", "var a = '\\u00e9'.repeat(1000000), b = '\\u00e9'.repeat(999999) + 'f'; var r = 0; for (var i = 0; i < 10; i++) r += a.localeCompare(b); r");
    run("concat-15000", "var s = ''; for (var i = 0; i < 15000; i++) { s += 'x'; } s.length");
}
```

Output (machine shared with other builds, so absolute times are noisy; the ratios are what matter):

```
baseline-loop  completed=true computrons=    67500034 ms=   7249.0 computrons/ms=    9311.6
baseline-str   completed=true computrons=     7125388 ms=    619.0 computrons/ms=   11510.9
bigint-mul     completed=true computrons=      128117 ms=   2198.9 computrons/ms=      58.3
bigint-div     completed=true computrons=       28493 ms=   1738.9 computrons/ms=      16.4
String(big)    completed=true computrons=       20357 ms=    179.6 computrons/ms=     113.4
big.toString   completed=true computrons=    79523920 ms=   2884.1 computrons/ms=   27573.2
BigInt(str)    completed=true computrons=       50035 ms=   1563.2 computrons/ms=      32.0
1n<str         completed=true computrons=       50029 ms=   1636.4 computrons/ms=      30.6
includes       completed=true computrons=       15047 ms=   4691.2 computrons/ms=       3.2
indexOf        completed=true computrons=       21151 ms=   5899.3 computrons/ms=       3.6
json-replacer  completed=true computrons=      297065 ms=   3502.1 computrons/ms=      84.8
json-deep      completed=true computrons=      330744 ms=    583.4 computrons/ms=     566.9
json-shallow   completed=true computrons=      262233 ms=     27.6 computrons/ms=    9495.8
localeCompare  completed=true computrons=      500374 ms=    975.9 computrons/ms=     512.7
concat-15000   completed=true computrons=      294262 ms=    888.5 computrons/ms=     331.2
```

Rust probe 2 (`ironhorse-vm/tests/zz_audit_nval_2.rs`, deleted): the same harness with `m.arm_meter(100, Box::new(move |c| c <= limit))`.

```
includes   limit=20000 completed=true  computrons=15047 ms=7962.2 halt=Return
bigint-mul limit=5000  completed=false computrons=6145  ms=8.4    halt=MeterAbort   (limit hit during setup; inconclusive)
control    limit=20000 completed=false computrons=20028 ms=0.8    halt=MeterAbort
```

Plain-host test262 summary (`t262run.py`): sloppy mode only; async and module cases skipped; no `$262`, so cross-realm cases fail as `call: not a function`; tip at `target/test262-report/test262-src`.

| Directory | Pass / total |
|---|---|
| built-ins/JSON | 163/165 |
| built-ins/String | 1218/1223 |
| built-ins/Number | 339/340 |
| built-ins/BigInt | 76/77 |
| built-ins/Date | 583/594 |
| built-ins/Math | 322/327 |
| built-ins/parseInt | 54/55 |
| built-ins/parseFloat | 53/54 |
| built-ins/Uint8Array | 68/70 |
| built-ins/decodeURIComponent | 54/56 (1 timeout) |
| built-ins/encodeURIComponent | 30/31 |
| built-ins/Temporal | 2023/4603 |
| intl402 | 785/3357 |
