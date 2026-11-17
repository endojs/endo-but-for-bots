function* t(n){ if (n>0) yield* t(n-1); else yield "leaf"; } var v; try { v = t(70).next().value; } catch (e) { v = "caught "+e; } throw new Error("yield* 70 => "+v);
