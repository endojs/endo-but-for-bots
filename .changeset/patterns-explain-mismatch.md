---
'@endo/patterns': minor
---

Add `@endo/patterns/explain-mismatch.js`, an opt-in submodule that renders a rich pattern-mismatch diagnostic.
The new `explainMismatch({ specimen, pattern, context? }, options?)` is a non-throwing matcher (mirrors `matches`) that returns a rendered string on mismatch, or `undefined` on match.
Two formats are supported: `compact` (default), one mismatch per line with ` | ` column separators, sized for AI-agent token economy; and `expanded` (opt-in), indented Rust-compiler-style line-art for humans reading at a REPL.
The production matcher path (`mustMatch`, `assertMatches`, `matches`) is unchanged and pays no additional cost; callers that never import the submodule never load it.
