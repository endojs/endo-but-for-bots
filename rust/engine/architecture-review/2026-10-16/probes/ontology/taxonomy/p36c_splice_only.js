let r; try { const a = new Array(140000); a[0] = 1; a.splice(0, 1); r = a.length; } catch (e) { r = "caught " + e; }
throw new Error("splice:" + r);
