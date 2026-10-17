let r; try { 1n << 10000000000n; r = "completed"; } catch (e) { r = "caught " + e.name; }
throw new Error(r);
