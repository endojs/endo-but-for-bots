// name: map-entries
// WASM-BLOCKERS.md B7, the repros too large for the fast shard: each needs gigabytes natively or
// minutes on wasm32, so `--shard slow` runs them one at a time.
//
// Unadmitted host allocations, bulk.rs:479: Map entries were admitted against no ceiling, so
// 2^25 + 1 of them completed natively and asked wasm32 for more than `isize::MAX` bytes. They are
// charged against the chunk ceiling now, and both targets halt `HeapExhausted` (B7 "Status").
var m = new Map(); for (var i = 0; i < 33554433; i++) m.set(i, i); m.size
// ---
// name: array-items
// bulk.rs:242: 80 kept arrays of 1,000,000 items were past what wasm32 can allocate; their items
// are charged against the chunk ceiling now.
var t = '[' + '0,'.repeat(999999) + '0]'; var k = [];
for (var i = 0; i < 80; i++) k.push(JSON.parse(t));
k.length + ':' + k[79].length
// ---
// name: intl-segmenter-segments
// interp/locale.rs:308: kept `Intl.Segmenter` segmentations of a 32M-unit string, each a host
// `Vec` of 24-byte entries natively and 12-byte ones on wasm32, took about 9 GB natively for 11.
// Each is charged its input and its 24-byte declared segments against the chunk ceiling now.
var s = 'a'.repeat(32 * 1024 * 1024); var seg = new Intl.Segmenter(); var k = [];
for (var i = 0; i < 11; i++) k.push(seg.segment(s));
k.length
// ---
// name: intl-list-format-copy
// natives/dispatch.rs:1967, intl.rs:757: `Intl.ListFormat` copied 2,000 references to one
// 1.1M-unit string before it found the number at the end, a catchable TypeError natively. It
// collects the list by reference now, so the TypeError comes first on both targets.
var s = 'x'.repeat(1100000); var a = []; for (var i = 0; i < 2000; i++) a.push(s); a.push(1);
try { new Intl.ListFormat('en').format(a).length; } catch (e) { e.name; }
// ---
// name: function-constructor-source
// flags: --eval-compiler
// interp/eval.rs:226, then ironhorse-compile/src/lexer.rs:167: the `Function` constructor
// assembled a 268.8M-code-point source, which the lexer's code-point buffer cannot hold on
// wasm32 (a contained panic, then `EngineInvariant`). The source is bounded by the chunk
// ceiling as it is assembled now.
var s = 'a'.repeat(22400000); var f = Function(s, s, s, s, s, s, s, s, s, s, s, s, '');
typeof f + f.length
// ---
// name: chunk-arena-doubling
// flags: --chunk-ceiling=1610612736
// Latent, embedder-raised ceilings, value.rs:2222: with a chunk ceiling above about 1 GiB, the
// chunk arena's amortized doubling asks wasm32 for more than `isize::MAX` before memory runs out.
// At 1.5 GiB, 17 kept 32M-unit strings returned natively and halted on wasm32. The probe builds
// with `consensus`, whose 2^29-byte chunk cap now refuses this ceiling on both targets.
var k = [];
for (var i = 0; i < 17; i++) k.push(String.fromCharCode(97 + i).repeat(32 * 1024 * 1024));
k.length
// ---
// name: scratch-over-2-gib
// flags: --chunk-ceiling=3758096384
// interp/admission.rs:236: at a 3.5 GiB chunk ceiling, one scratch buffer over 2 GiB returned
// natively and halted on wasm32 in `reserved_vec`. The consensus chunk cap now refuses the ceiling.
'a'.repeat(1100000000).length
// ---
// name: chunk-ceiling-2-30-doubling
// flags: --chunk-ceiling=1073741824
// Latent: at a 2^30 chunk ceiling, B8's 1M-unit doubling program halted natively, while wasm32
// could not allocate 1 GiB in `units_to_be16`. The consensus chunk cap now refuses the ceiling.
var s = 'x'.repeat(1 << 20); for (;;) s = s + s;
// ---
// name: slot-ceiling-kept-objects-doubling
// flags: --chunk-ceiling=536870912 --slot-ceiling=44739242
// Latent: at a 2^29 chunk ceiling both targets halt the doubling identically, but with the slot
// ceiling at the `isize::MAX` wall, 44,000,000 kept objects fill most of wasm32's address space,
// and the same doubling after them halts `HostAllocationFailed` on wasm32 where native halts at
// the chunk ceiling. The objects are kept as a prototype chain, one slot each: an array of them
// is charged against the chunk ceiling and halts there first, identically on both targets, and a
// property on each would take a second slot, past the slot ceiling.
var k = null; for (var i = 0; i < 44000000; i++) k = Object.create(k);
var s = 'x'.repeat(1 << 20); for (;;) s = s + s;
