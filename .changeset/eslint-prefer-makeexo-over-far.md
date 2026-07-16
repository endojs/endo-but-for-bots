---
'@endo/eslint-plugin': minor
---

Add a `prefer-makeexo` shared ESLint config that steers authors from `Far`
toward `makeExo`. It flags bare `Far(...)` call sites (`no-restricted-syntax`)
and the `Far` named import from `@endo/far` (`no-restricted-imports`), and the
message names the `makeExo('Name', M.interface('Name', {}, { defaultGuards:
'passable' }), { ... })` replacement plus the inline `eslint-disable`
escape hatch for the extenuating cases where `Far` is genuinely the right tool.
It is opt-in via `extends: ['plugin:@endo/prefer-makeexo']` so it applies only
to the packages that adopt it, leaving packages that use `Far` legitimately
untouched. Non-`Far` members of `@endo/far` (`E`, `ERef`, ...) and the
type-only `/** @import { ERef } from '@endo/far' */` comment form are not
flagged. The rules are warnings while existing call sites are migrated.
