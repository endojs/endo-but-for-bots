---
'@endo/eslint-plugin': major
---

**Breaking:** `eslint-plugin-unicorn` is now a `^72.0.0` dependency, up from `^56.0.1`.
That release line declares a peer requirement of ESLint `>=10.4`, so consumers still on ESLint 8 or 9 should stay on the previous major of this package.

The plugin registers `eslint-plugin-unicorn` under the `unicorn` namespace and enables exactly one of its rules, `unicorn/numeric-separators-style`.
Any additional `unicorn/*` rule a consumer enables against that registration now resolves to the v72 implementation.

`unicorn/numeric-separators-style` gained a `fractionGroupLength` option that controls grouping of the digits after a decimal point, and it defaults to no fractional grouping at all.
This package sets it to `3`, so a fractional part is still grouped in threes from the decimal point and literals such as `3.141_59` and `1.110_223_024_625_156_5e-16` continue to lint clean.
Consumers who extend this package's configuration need not reformat any numeric literal.
