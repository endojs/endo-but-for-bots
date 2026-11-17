const a = []; for (let i = 0; i < 3; i++) a.push(3 - i);
let m;
try { a.sort(); m = "ok " + a.join(); } catch (e) { m = e.message; }
throw new Error(m);
