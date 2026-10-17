let r = "no"; try { r = String("a".padEnd(2 ** 24 + 1).length); } catch (e) { r = "caught " + e.name; } throw new Error("pad:" + r);
