// name: map-entries
// WASM-BLOCKERS.md B7, the repros too large for the fast shard: each needs gigabytes natively or
// minutes on wasm32, so `--shard slow` runs them one at a time.
//
// Unadmitted host allocations, bulk.rs:479: Map entries are admitted against no ceiling, so
// 2^25 + 1 of them complete natively and ask wasm32 for more than `isize::MAX` bytes.
var m = new Map(); for (var i = 0; i < 33554433; i++) m.set(i, i); m.size
// ---
// name: array-items
// bulk.rs:242: 80 kept arrays of 1,000,000 items, past what wasm32 can allocate.
var t = '[' + '0,'.repeat(999999) + '0]'; var k = [];
for (var i = 0; i < 80; i++) k.push(JSON.parse(t));
k.length + ':' + k[79].length
// ---
// name: intl-segmenter-segments
// interp/locale.rs:308: kept `Intl.Segmenter` segmentations of a 32M-unit string, each a host
// `Vec` of 24-byte entries natively and 12-byte ones on wasm32. B7's 8 fit in wasm32's 4 GiB on
// this tree and agree with native, so 11 are kept; natively they take about 9 GB.
var s = 'a'.repeat(32 * 1024 * 1024); var seg = new Intl.Segmenter(); var k = [];
for (var i = 0; i < 11; i++) k.push(seg.segment(s));
k.length
// ---
// name: intl-list-format-copy
// natives/dispatch.rs:1967, intl.rs:757: `Intl.ListFormat` copies 2,000 references to one 1.1M-unit
// string before it finds the number at the end, which is a catchable TypeError natively.
var s = 'x'.repeat(1100000); var a = []; for (var i = 0; i < 2000; i++) a.push(s); a.push(1);
try { new Intl.ListFormat('en').format(a).length; } catch (e) { e.name; }
// ---
// name: function-constructor-source
// flags: --eval-compiler
// interp/eval.rs:226, then ironhorse-compile/src/lexer.rs:167: the `Function` constructor
// assembles a 268.8M-code-point source, which the lexer's code-point buffer cannot hold on
// wasm32 (a contained panic, then `EngineInvariant`).
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
// Latent: at a 2^30 chunk ceiling, B8's 1M-unit doubling program halted natively and trapped on
// wasm32 when `units_to_be16` could not allocate 1 GiB. The consensus chunk cap now refuses it.
var s = 'x'.repeat(1 << 20); for (;;) s = s + s;
// ---
// name: slot-ceiling-kept-objects-doubling
// flags: --chunk-ceiling=536870912 --slot-ceiling=44739242
// Latent: at a 2^29 chunk ceiling both targets halt the doubling identically, but with the slot
// ceiling at the `isize::MAX` wall, 44,000,000 kept objects take 3.23 GB of wasm32 linear memory
// and the same doubling after them traps on wasm32. On this tree wasm32 halts while it keeps the
// objects, earlier than native, which halts in the doubling.
var k = []; for (var i = 0; i < 44000000; i++) k.push({});
var s = 'x'.repeat(1 << 20); for (;;) s = s + s;
