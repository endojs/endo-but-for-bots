let r;
try { r = eval("/b{2147483648}/").test(""); } catch (e) { r = "caught " + e.name; }
throw new Error("result: " + r);
