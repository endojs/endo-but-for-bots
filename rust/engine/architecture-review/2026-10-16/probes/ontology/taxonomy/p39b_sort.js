let r; try { const a = new Array(70000); for (let i = 0; i < 70000; i += 2) a[i] = 70000 - i; r = a.sort((x, y) => x - y).length; } catch (e) { r = "caught " + e; }
throw new Error("sort-holey:" + r);
