const out = {};
const a = 1n << 35000n;
out.mulBits = (a * a * 2n).toString(2).length;
try { out.powBits = (2n ** 70001n).toString(2).length; } catch (e) { out.pow = "caught " + e; }
throw new Error(JSON.stringify(out));
