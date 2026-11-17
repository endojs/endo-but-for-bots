const a = [];
let n = 0;
try { for (let i = 199999; i >= 0; i--) { a[i] = i; n++; } } catch (e) { throw new Error("reverse fill after " + n + ": " + e); }
throw new Error("reverse ok " + n);
