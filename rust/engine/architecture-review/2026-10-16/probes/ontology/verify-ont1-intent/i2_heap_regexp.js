let r = "no"; try { r = String(/^a+$/.test("a".repeat(65537))); } catch (e) { r = "caught " + e.name; } throw new Error("re:" + r);
