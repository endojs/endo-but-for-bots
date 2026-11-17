let r; try { "x".padStart(2**30, "ab"); r = "completed"; } catch (e) { r = "caught " + e.name; }
throw new Error(r);
