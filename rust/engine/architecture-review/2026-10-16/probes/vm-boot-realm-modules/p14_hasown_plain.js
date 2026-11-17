// Control: 100,000 Object.hasOwn calls (a native call with no own-keys walk).
var o = { a: 1 }; var n = 0;
for (var i = 0; i < 100000; i++) n += Object.hasOwn(o, "a") ? 1 : 0;
