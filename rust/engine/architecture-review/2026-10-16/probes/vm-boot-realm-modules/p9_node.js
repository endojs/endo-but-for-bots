var o = {}; var t = Date.now(); for (var j = 0; j < 20000; j++) o["k" + j] = j; console.log("node", Date.now() - t, "ms");
