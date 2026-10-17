let r; try { BigInt.asUintN(2**40, -1n); r = "completed"; } catch (e) { r = "caught " + e.name; }
throw new Error(r);
