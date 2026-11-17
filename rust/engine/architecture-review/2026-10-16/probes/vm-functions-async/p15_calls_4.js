function f(a) { let b = a; let c = b; let d = c; let e = d; return e; }
let s = 0; for (let i = 0; i < 10000; i++) s = f(i);
