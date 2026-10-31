var a = []; for (let i = 0; i < 3; i++) a.push(3 - i);
var m;
try { a.sort(); m = "ok " + a.join(); } catch (e) { m = e.message; }
throw new Error(m);
