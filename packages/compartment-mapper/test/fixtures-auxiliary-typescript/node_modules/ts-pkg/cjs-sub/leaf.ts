// `.ts` under the `{"type":"commonjs"}` auxiliary parses as CommonJS (cts).
// `module.exports` is invalid in an ECMAScript module, so this file only loads
// if the auxiliary override flips `.ts` to cts — the load-bearing regression.
module.exports = 'cts-leaf';
