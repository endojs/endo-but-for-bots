// Module byte-identity corpus: top-level await marks the module awaiting.
// Whole MODULE programs separated by `// ---`.
//
// Regression cover for the oracle bump 8.2.3 -> 8.3.1 (moddable
// `c41a35d165` "for await in module body", xsSyntaxical.c): a top-level
// `for await` sets `parser->flags |= mxAwaitingFlag`, so the module node's
// root flags carry AWAITING and the module compiles as async. Without the
// mirrored `self.flags |= flags::AWAITING;` in `for_statement`
// (ironhorse-compile/src/parser/stmt.rs) these diverge (`ironhorse-shorter` — the
// port omits the async-module machinery the 8.3.1 oracle emits). See
// rust/engine/README.md § Upstream moddable delta tracking, item 2.

// top-level for-await over a sync-iterable literal
for await (const x of []) { x; }
// ---
// top-level for-await with a body effect and a trailing export
let seen = 0;
for await (const y of [1, 2]) { seen += y; }
export { seen };
