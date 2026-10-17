let r;
try { r = "asUintN bits:" + BigInt.asUintN(120001, -1n).toString(2).length; } catch (e) { r = "caught " + e; }
throw new Error(r);
