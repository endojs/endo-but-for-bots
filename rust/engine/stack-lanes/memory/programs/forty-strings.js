// WASM-BLOCKERS.md B8's capped-host program: forty kept strings of 2^20 code
// units, about 80 MiB of chunks, far under the default 256 MiB ceiling.
var a = [];
for (var i = 0; i < 40; i++) a.push('x'.repeat(1 << 20));
a.length
