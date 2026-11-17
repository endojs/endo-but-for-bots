// name: regexp-test-subject
// WASM-BLOCKERS.md B7: the repros of the B7 tables that run in seconds. cross_target.py runs them
// on the native and wasm32 probes and expected-divergence/wasmtime.json lists each one that still
// diverges; differential.py runs them natively, so a B7 fix that moves a native threshold fails
// there. The repros of "Admission charged by Rust memory layout", "Arithmetic on the host's
// `usize`" and "Unadmitted host allocations" agree on both targets since those families were
// fixed (B7 "Status"), and stay as regression tests that the gate checks as `same`. Their fillers bring the chunk arena to a few
// kilobytes of its 256 MiB ceiling, where a charge of `size_of::<T>()` halted natively and
// completed on wasm32; a declared width now halts both.
//
// natives/regexp.rs:1012: the matcher's `usize` scratch for a 16M-unit subject.
var s = 'a'.repeat(16 * 1024 * 1024); var f = 'b'.repeat(64 * 1024 * 1024); /z/.test(s)
// ---
// name: regexp-replace-all
// natives/regexp.rs:1393: `replaceAll`'s `usize` match positions.
'a'.repeat(30000000).replaceAll('a', 'c').length
// ---
// name: regexp-replace-global
// natives/regexp.rs:1490: a global replace's `(Slot, usize, usize)` matches, after a 134.1M-unit
// filler.
var f = 'b'.repeat(134100000); 'a'.repeat(5000).replace(/a/g, 'b').length
// ---
// name: json-stringify-holes
// natives/json.rs:591, :708: `JSON.stringify`'s `Vec<u16>` per element, after a 134.2M-unit
// filler.
var f = 'b'.repeat(134200000); JSON.stringify(new Array(1000)).length
// ---
// name: json-parse-reviver-array
// natives/json.rs:1095: a reviver walk's `JsonSource` per array element, after B7's 134.186M-unit
// filler, moved to the middle of the 4,000-unit window where the targets' charges differed before
// the fix: native halted from 134,184,894 units and wasm32 completed up to 134,188,893.
var f = 'b'.repeat(134186900); var t = '[' + '1,'.repeat(999) + '1]';
JSON.parse(t, function (k, v) { return v; }).length
// ---
// name: json-parse-reviver-object
// natives/json.rs:1204: a reviver walk's `(ReadKey, JsonSource)` per member of a 1,000-member
// object. The two targets' charges differed by 8,000 bytes before the fix, so the filler sits in
// the middle of that window: native halted from 134,118,997 units and wasm32 completed up to
// 134,122,996.
var f = 'b'.repeat(134121000);
var p = []; for (var i = 0; i < 1000; i++) p.push('"k' + i + '":' + i);
typeof JSON.parse('{' + p.join() + '}', function (k, v) { return v; })
// ---
// name: regexp-compile-nodes
// ironhorse-regexp/src/compile.rs:953, :955-962, :1366-1375, :1717: the RegExp compiler's `Node`
// and `Vec<u32>` headers, which the compiler now charges at declared widths, so both targets halt
// here (WASM-BLOCKERS.md B7 "Status").
new RegExp('a'.repeat(420000)).test('a')
// ---
// name: regexp-literal-compile-nodes
// flags: --eval-compiler
// The same compiler sites through a RegExp literal, which a top-level script refused at compile
// time natively (`RegExpResourceLimit`) and compiled on wasm32 before the fix; compiled here by
// `Function`, so that the literal need not be in this file.
var r;
try { r = Function('return /' + 'a'.repeat(420000) + '/')().test('a'); } catch (e) { r = e.name; }
r
// ---
// name: regexp-match-states
// ironhorse-regexp/src/matcher.rs:129, :190-193: the matcher's `State` and `AssertionData`.
new RegExp('()'.repeat(129) + 'a*$').test('a'.repeat(62500))
// ---
// name: regexp-advance-index-symbol-replace
// Arithmetic on the host's `usize`, natives/regexp.rs:301: `advance_string_index` computed
// `lastIndex + 1` in `usize`, which overflowed on wasm32 only, and the overflow check panicked;
// it no longer adds to the guest index in `usize` (WASM-BLOCKERS.md B7 "Status").
var re = /(?:)/gu; var n = 0;
re.exec = function () { if (n++) return null; this.lastIndex = 4294967295; return ['']; };
re[Symbol.replace]('x', 'Q')
// ---
// name: regexp-advance-index-symbol-match
// natives/regexp.rs:301 through `@@match`.
var re = /(?:)/gu; var n = 0;
re.exec = function () { if (n++) return null; this.lastIndex = 4294967295; return ['']; };
re[Symbol.match]('x').length
// ---
// name: regexp-advance-index-string-replace
// natives/regexp.rs:301 through `String.prototype.replace`.
var re = /(?:)/gu; var n = 0;
re.exec = function () { if (n++) return null; this.lastIndex = 4294967295; return ['']; };
'x'.replace(re, 'Q')
// ---
// name: regexp-advance-index-match-all
// natives/regexp.rs:301 through `matchAll`, whose iterator runs a species copy of the RegExp, so
// the `exec` that moves `lastIndex` is the prototype's.
var n = 0;
RegExp.prototype.exec = function () {
  if (n++) return null; this.lastIndex = 4294967295; return [''];
};
var step = 'x'.matchAll(/(?:)/gu).next();
[step.done, step.value.length, n].join()
// ---
// name: json-stringify-output-size
// natives/json.rs:163: `JSON.stringify` converted its computed output size from `u64` to `usize`
// before checking the result limit, so an array nested 450 deep with indentation 10 was a
// catchable RangeError natively and HeapExhausted on wasm32; it sizes the output in `u64` now,
// and both targets throw the RangeError.
var a = new Array(1000000); for (var i = 0; i < 450; i++) a = [a];
try { JSON.stringify(a, null, 10).length; } catch (e) { e.name + ':' + e.message; }
// ---
// name: typed-array-join
// Unadmitted host allocations, natives/buffer.rs:558: `%TypedArray%.prototype.join` built its
// result in a host `Vec` before admitting it. Past 2^29 units the next growth asked wasm32 for
// more than `isize::MAX` bytes and panicked; natively the result was refused at admission. The
// copy is bounded by the chunk ceiling before it grows now, on both targets.
new Uint8Array(8193).join('x'.repeat(65536)).length
// ---
// name: typed-array-to-locale-string
// natives/buffer.rs:287: `%TypedArray%.prototype.toLocaleString`, the same way.
var s = 'x'.repeat(65536);
Number.prototype.toLocaleString = function () { return s; };
new Uint8Array(8193).toLocaleString().length
// ---
// name: array-to-locale-string
// natives/array.rs:4482: `Array.prototype.toLocaleString`, the same way.
var s = 'x'.repeat(65536); var o = { toLocaleString: function () { return s; } };
var a = []; for (var i = 0; i < 8193; i++) a.push(o);
a.toLocaleString().length
