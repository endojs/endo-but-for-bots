/*---
description: stage3-math corpus line 55 converted to a test262 case
flags: [noStrict]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage3-math.js line 55.
  Original corpus line: Math.acosh(2.3)
  Source: [1.4750447812414251, 1.475044781241425].includes(Math.acosh(2.3))

  Math.acosh is implementation-approximated, and the XS oracle uses the host
  libm. The exact result 1.47504478124142499418... lies between two binary64
  values, so the case (and its dual-run Source program) accepts exactly those
  two faithful roundings:
  0x3ff799c88e79140d (glibc <= 2.39, Rust std) and
  0x3ff799c88e79140c (correctly rounded; glibc 2.43 on ubuntu-26.04,
  libm 0.2.16). Any other value still fails.
---*/
assert.sameValue([1.4750447812414251, 1.475044781241425].includes(Math.acosh(2.3)), true);
