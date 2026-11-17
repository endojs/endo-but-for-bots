(function(){ var m = new Map([['alpha', 1]]); var k = 'alpha'; var s = 0; for (var i = 0; i < 100000; i++) { s += m.get(k); } })();
