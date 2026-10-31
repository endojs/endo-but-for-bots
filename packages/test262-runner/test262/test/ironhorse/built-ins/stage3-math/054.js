/*---
description: stage3-math corpus line 54 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-math.js line 54.
  Source: Math.asinh(1.7)

  Math.asinh is implementation-approximated, and the XS oracle uses the host
  libm. The exact result 1.30082042684064683187... lies between two binary64
  values, so the case accepts exactly those two faithful roundings:
  0x3ff4d0291473fd4a (glibc <= 2.39, libm 0.2.16, Rust std) and
  0x3ff4d0291473fd4b (correctly rounded; glibc 2.43 on ubuntu-26.04).
  Any other value still fails.
---*/
assert.sameValue([1.3008204268406467, 1.300820426840647].includes(Math.asinh(1.7)), true);
