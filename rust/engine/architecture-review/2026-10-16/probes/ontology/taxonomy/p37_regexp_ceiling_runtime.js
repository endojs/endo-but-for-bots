let r; try { r = String(new RegExp("b{9007199254740991}").test("b")); } catch (e) { r = "caught " + e; }
throw new Error(r);
