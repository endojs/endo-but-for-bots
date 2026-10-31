// A guest that guards against the failure cannot observe it.
let r = "not reached";
try { "x".padEnd(2 ** 24 + 1, "x"); r = "completed"; } catch (e) { r = "caught " + e; } finally { r += " +finally"; }
throw new Error(r);
