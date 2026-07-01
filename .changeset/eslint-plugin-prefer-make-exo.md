---
'@endo/eslint-plugin': minor
---

Add a `@endo/prefer-make-exo` rule that flags `Far(...)` calls and steers
authors toward `makeExo(...)`. `Far` is discouraged but not forbidden, so the
rule is wired into the shared `recommended` config (and thus inherited by every
package through `strict` → `internal`) at `warn` severity with a documented
escape hatch: suppress with a `// eslint-disable-next-line @endo/prefer-make-exo
-- <reason>` directive that records why `Far` is genuinely required. Because
`Far` remains in wide use across the tree, the rule warns rather than errors so
CI stays green while new code is steered to `makeExo`.
