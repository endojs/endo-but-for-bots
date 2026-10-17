const r = [Math.fround(16777217), Math.fround(2147483647), Math.hypot(1e200, 1e200, 1e200), Math.hypot(1e-200, 1e-200, 1e-200),
  Math.hypot(NaN, Infinity, 1), Math.hypot(1e200, 1e200), Math.round(4503599627370495.5), Math.round(-4503599627370495.5), Math.round(2251799813685248.5),
  Math.fround(16777217.0 + 0), Math.fround(1.5 * 2 ** 24 + 1)];
throw new Error(JSON.stringify(r.map(String)));
