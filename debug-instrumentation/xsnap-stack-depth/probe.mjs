import '@endo/init/debug.js';
import { passStyleOf } from '@endo/pass-style';
import { makeMarshal } from '@endo/marshal';
import { M, mustMatch } from '@endo/patterns';

const { toCapData, fromCapData } = makeMarshal(undefined, undefined, {
  serializeBodyFormat: 'smallcaps',
});
const mkRec = d => { let n = harden({ leaf: 'end' }); for (let i=0;i<d;i++) n = harden({ x: n }); return n; };
const mkPat = d => { let p = M.any(); for (let i=0;i<d;i++) p = M.splitRecord({ x: p }); return harden(p); };

const probe = (label, fn) => {
  let lo = 1, hi = 1;
  for (;;) { try { fn(hi); lo = hi; hi *= 2; if (hi > 2_000_000) break; } catch { break; } }
  let bad = hi;
  while (lo + 1 < bad) { const mid = (lo + bad) >> 1; try { fn(mid); lo = mid; } catch { bad = mid; } }
  console.log(`${label}: max survivable V8 depth = ${lo}`);
  return lo;
};

probe('passStyleOf', d => passStyleOf(mkRec(d)));
probe('marshal round-trip', d => fromCapData(toCapData(mkRec(d))));
probe('mustMatch', d => mustMatch(mkRec(d), mkPat(d)));
