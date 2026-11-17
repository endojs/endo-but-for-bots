let r; try { r = /^\P{ASCII}+$/u.test("é".repeat(100000)); } catch (e) { r = "caught " + e; }
throw new Error("100000:" + r);
