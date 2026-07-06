// `.mts` stays an ECMAScript module even inside the `{"type":"commonjs"}`
// subtree — Node.js never lets an enclosing `type` reclassify `.mts`. `export`
// is invalid in CommonJS, so this loads only if `.mts` is NOT flipped to cts.
export default 'mts-under-cjs';
