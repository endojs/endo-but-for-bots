let r; try { Array.prototype.fill.call({length: 2**40}, 0, 2**40 - 2); r = "completed"; } catch (e) { r = "caught " + e.name; }
throw new Error(r);
