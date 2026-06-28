// Probe module bundled (beta2 endo set) and evaluated INSIDE xsnap.
// Mirrors /tmp/endo-beta2/probe.mjs (the V8 probe) so XS vs V8 is apples-to-apples.
import { passStyleOf } from '@endo/pass-style';
import { makeMarshal } from '@endo/marshal';
import { M, mustMatch } from '@endo/patterns';

const { toCapData, fromCapData } = makeMarshal(undefined, undefined, {
  serializeBodyFormat: 'smallcaps',
});

const mkRec = d => {
  let n = harden({ leaf: 'end' });
  for (let i = 0; i < d; i++) n = harden({ x: n });
  return n;
};
const mkPat = d => {
  let p = M.any();
  for (let i = 0; i < d; i++) p = M.splitRecord({ x: p });
  return harden(p);
};

// Each returns nothing; it either completes or trips the XS stack meter (worker dies).
export const passStyle = d => { passStyleOf(mkRec(d)); return d; };
export const marshalRT = d => { fromCapData(toCapData(mkRec(d))); return d; };
export const matchD = d => { mustMatch(mkRec(d), mkPat(d)); return d; };
