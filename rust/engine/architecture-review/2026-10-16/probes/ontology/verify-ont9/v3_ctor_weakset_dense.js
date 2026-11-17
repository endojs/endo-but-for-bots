let r; try { new WeakSet([Symbol("a")]); r = "ctor ok"; } catch (e) { r = "ctor " + e.name; } throw new Error(r);
