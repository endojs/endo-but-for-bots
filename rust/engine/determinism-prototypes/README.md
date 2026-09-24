# Cross-target determinism fix prototypes

These patches fix part of what
[WASM-BLOCKERS.md B7](../WASM-BLOCKERS.md#b7-native-and-wasm32-diverge-wherever-accounting-or-allocation-depends-on-the-host)
describes: places where the same guest program gets a different result or computron count on
wasm32 than on native x86_64.
They come from the audit behind B7 and are evidence that the fixes work.
They are not changes proposed for merging as they stand.

Both apply to the tree at the commit that added this directory.
Apply them from the repository root:

```sh
git apply --directory=rust/engine rust/engine/determinism-prototypes/<patch>
```

| Patch | What it changes |
|---|---|
| `fixed-widths-and-string-index.patch` | Scratch admission charges a declared width per element type (a `ScratchElement` trait) instead of `size_of::<T>()`. The widths are the audited 64-bit layouts, checked by a compile-time assertion on 64-bit targets, so native thresholds do not move. It also pins the RegExp matcher's `State`, `AssertionData` and `QuantifierData` charges the same way (`QuantifierData` has no pointer-sized field, so its pin only keeps the three consistent), and stops `advance_string_index` from computing `index + 1` in `usize`. |
| `json-output-size-u64.patch` | `JSON.stringify` checks its output size against the result limit in `u64` before converting to `usize`, so an oversized result is the same catchable `RangeError` on every target. |

## Validation

Both patches were applied together.
Native and wasm32 (Wasmtime, `exnref`) probes were built against the patched tree.
Each repro ran on the unpatched native probe and on both patched probes.
The unpatched wasm32 column is from the audit's wasm32 runs of the same repros.
In the patched columns, "= unpatched" means the same halt and computron count as unpatched
native, and "= native" the same as both native columns:

| Repro | Unpatched native | Unpatched wasm32 | Patched native | Patched wasm32 |
|---|---|---|---|---|
| `/z/.test` on a 16M-unit subject with a 64M-unit filler | `HeapExhausted`, 20,972,860 | `Return false`, 37,750,079 | = unpatched | = native |
| `'a'.repeat(30000000).replaceAll('a','c').length` | `HeapExhausted`, 14,013,699 | `Return 30000000`, 30,000,936 | = unpatched | = native |
| `replace(/a/g, 'b')` after a 134.1M-unit filler | `HeapExhausted`, 33,552,805 | `Return 5000`, 33,579,763 | = unpatched | = native |
| `JSON.stringify(new Array(1000))` after a 134.2M-unit filler | `HeapExhausted`, 33,553,334 | `Return 5001`, 33,553,337 | = unpatched | = native |
| `JSON.parse` with a reviver after a 134.186M-unit filler | `HeapExhausted`, 33,549,846 | `Return 1000`, 33,563,123 | = unpatched | = native |
| `new RegExp('()'.repeat(129)+'a*$').test('a'.repeat(62500))` | `HeapExhausted`, 202,597 | `Return true`, 203,696 | = unpatched | = native |
| a custom `exec` that sets `lastIndex = 2**32 - 1`, then `@@replace` | `Return "Qx"`, 118 | trap (overflow panic) | = unpatched | = native |
| `JSON.stringify` of an array nested 450 deep with indentation 10 | `Return "RangeError:result too large"`, 268,657,025 | `HeapExhausted`, 268,656,997 | = unpatched | = native |
| *Control:* `new RegExp('a'.repeat(420000)).test('a')` (the RegExp compiler, not patched) | `HeapExhausted`, 288,772 | `Return false`, 321,730 | = unpatched | `Return false`, 321,730 |

Before the patches, wasm32 differed from native on every row: it completed where native halted,
trapped on the `lastIndex` row, and halted where native threw a `RangeError`.
The control row still differs, as expected, because no patch touches the RegExp compiler.

With both patches applied, `cargo test --release -p ironhorse-vm -p ironhorse-regexp --no-fail-fast`
passes 1,187 tests and fails 1.
The failure is `moved_json_methods_cannot_bypass_allocation_admission` in
`ironhorse-vm/tests/allocation_admission_audit.rs`, a source-mutation test anchored on the exact
line `self.json_reserve_output(state, size)?;`.
`json-output-size-u64.patch` rewrites that line, so a production version must update the anchor.

## What these patches do not fix

Everything else in B7 remains, including:

- the RegExp compiler's `size_of::<Node>()` and `Vec<u32>` header charges
  (`ironhorse-regexp/src/compile.rs:953`, `:955-962`, `:1717`);
- the unadmitted array items, Map, Set and Intl side tables, and guest-amplified host copies;
- the snapshot and store findings.
