let r;
try { r = /^a+$/.test("a".repeat(70000)); } catch (e) { r = "caught " + e; }
throw new Error("after:" + r);
