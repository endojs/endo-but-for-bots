(function(){ var o = {}; var n = 0; for (var i = 0; i < 70000; i++) { if (("k" + i) in o) n++; } })(); throw new Error("in-done");
