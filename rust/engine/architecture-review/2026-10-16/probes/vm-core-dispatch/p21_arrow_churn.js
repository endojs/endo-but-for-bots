(function(){ var a = [1]; var s = 0; for (var i = 0; i < 300000; i++) { a.forEach(x => { s += x; }); } })(); throw new Error("done");
