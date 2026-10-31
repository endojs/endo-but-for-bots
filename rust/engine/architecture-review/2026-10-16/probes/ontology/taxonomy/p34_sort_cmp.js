let r; try { [2, 1].sort(() => { "x".padEnd(2 ** 24 + 1, "x"); return 0; }); r = "completed"; } catch (e) { r = "caught " + e; }
throw new Error(r);
