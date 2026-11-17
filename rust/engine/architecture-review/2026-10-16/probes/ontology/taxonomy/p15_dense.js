const a = [];
let n = 0;
try { for (let i = 0; i < 200000; i++) { a.push(i); n++; } } catch (e) { throw new Error("push after " + n + ": " + e); }
const b = [];
let m = 0;
try { for (let i = 0; i < 200000; i++) { b[i] = i; m++; } } catch (e) { throw new Error("index-assign after " + m + ": " + e); }
throw new Error("dense ok " + n + " " + m);
