let r;
try { r = "pow bits:" + (2n ** 120000n).toString(2).length; } catch (e) { r = "caught " + e; }
throw new Error(r);
