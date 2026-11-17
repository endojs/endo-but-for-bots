let r; try { new Array(2**32); r = "completed"; } catch (e) { r = "caught " + e.name; }
throw new Error(r);
