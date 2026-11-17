let r;
try { r = new RegExp("b{9007199254740991}", "u"); } catch (e) { throw new Error("caught " + e.name + ": " + e.message); }
throw new Error("ok " + r.test(""));
