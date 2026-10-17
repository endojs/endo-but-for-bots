let r;
try { r = "shl bits:" + (1n << 120000n).toString(2).length; } catch (e) { r = "caught " + e; }
throw new Error(r);
