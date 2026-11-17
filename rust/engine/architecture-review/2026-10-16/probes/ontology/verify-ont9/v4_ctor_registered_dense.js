let r; try { new WeakMap([[Symbol.for("reg"), 1]]); r = "ctor ok"; } catch (e) { r = "ctor " + e.name; } throw new Error(r);
