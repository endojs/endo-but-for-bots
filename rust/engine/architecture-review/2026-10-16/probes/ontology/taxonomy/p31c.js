let r; try { r = /^a+$/.test("a".repeat(1000000)); } catch (e) { r = "caught " + e; }
throw new Error("1e6 a+:" + r);
