let r; try { r = Array.from({ length: 70000 }, (_, i) => i).length; } catch (e) { r = "caught " + e; }
throw new Error("Array.from:" + r);
