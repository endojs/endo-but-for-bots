(function(){ var o = {}; for (var i = 0; i < 70000; i++) { o["k" + i] = 1; delete o["k" + i]; } })(); throw new Error("set-delete-done");
