// The worst running string case WASM-BLOCKERS.md B8 measured: one string of
// 2^20 code units doubled N times (each doubling builds the result from two
// copies of the operand).
var s = 'x'.repeat(1 << 20);
for (var i = 0; i < __N__; i++) s = s + s;
s.length
