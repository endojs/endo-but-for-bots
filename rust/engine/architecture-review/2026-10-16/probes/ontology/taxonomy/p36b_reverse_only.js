let r; try { r = new Array(140000).reverse().length; } catch (e) { r = "caught " + e; }
throw new Error("reverse:" + r);
