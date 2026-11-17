// names pre-interned by a first object, then a second object built from the same names
var a = {}, b = {};
for (var i = 0; i < 8000; i++) a['k' + i] = i;
var t0 = Date.now();
for (var i = 0; i < 8000; i++) b['k' + i] = i;
