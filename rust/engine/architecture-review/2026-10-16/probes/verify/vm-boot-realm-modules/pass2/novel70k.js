var o = {}; var n = 0; try { for (var j = 0; j < 70000; j++) { o["k" + j] = j; n = j; } } catch (e) { throw new Error("stopped at " + n + ": " + e); } 0
