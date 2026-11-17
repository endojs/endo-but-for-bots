let r = "no"; try { const a = { length: 2 ** 32 - 1 }; r = String(Array.prototype.join.call(a, "").length); } catch (e) { r = "caught " + e.name; } throw new Error("join:" + r);
