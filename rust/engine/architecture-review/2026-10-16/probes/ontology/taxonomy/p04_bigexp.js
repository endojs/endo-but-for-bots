let r; try { 2n ** 100000000n; r = "completed"; } catch (e) { r = "caught " + e.name; }
throw new Error(r);
