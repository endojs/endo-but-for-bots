let r;
try { "x".padEnd(Infinity, "y"); r = "completed"; } catch (e) { r = "caught " + e.name; }
throw new Error(r);
