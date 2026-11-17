// `**` refuses > 64Ki projected bits; `*` has no cap and builds a 1.6M-bit value
var a = 10n ** 15000n; var b = a; for (var i = 0; i < 5; i++) b = b * b;
throw new Error('hexdigits=' + b.toString(16).length);
