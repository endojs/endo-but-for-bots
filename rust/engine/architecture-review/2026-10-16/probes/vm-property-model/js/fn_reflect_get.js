(function(){ var o = {alpha: 1}; var k = 'alpha'; var s = 0; for (var i = 0; i < 100000; i++) { s += Reflect.get(o, k); } })();
