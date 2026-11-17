let r; try { "x".repeat(2**30); r = "completed"; } catch (e) { r = "caught " + e.name; }
throw new Error(r);
