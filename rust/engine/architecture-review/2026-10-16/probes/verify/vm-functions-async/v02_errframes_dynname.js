var L = typeof LEN === 'undefined' ? 1 : LEN;
var name = 'f' + 'x'.repeat(NAMELEN);
var o = { [name]: function (n) { if (n > 0) return o[name](n - 1); for (var i = 0; i < 20; i++) keep.push(new Error('e')); return 0; } };
var keep = [];
o[name](200);
throw new Error('done errors=' + keep.length + ' namelen=' + o[name].name.length);
