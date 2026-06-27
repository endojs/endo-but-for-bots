// A deeper directory with no package.json inherits the nearest auxiliary
// (`{"type":"commonjs"}`), so `.ts` here is CommonJS (cts) too.
module.exports = 'cts-deep';
