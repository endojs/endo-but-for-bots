var r = [];
var o = Object.freeze({ n: NaN, z: -0, p: 0 });
function t(f) { try { f(); return "ok"; } catch (e) { return e.constructor.name; } }
r.push(t(function () { Object.defineProperty(o, "n", { value: NaN }); }));
r.push(t(function () { Object.defineProperty(o, "n", { value: 0 / 0 }); }));
r.push(t(function () { Object.defineProperty(o, "z", { value: 0 }); }));
r.push(t(function () { Object.defineProperty(o, "p", { value: -0 }); }));
r.push(t(function () { Object.defineProperty(o, "z", { value: -0 }); }));
r.push(Reflect.defineProperty(o, "p", { value: 0 }));
r.push(Reflect.defineProperty(o, "p", { value: -0 }));
var m = new Map([[NaN, 1], [-0, 2]]);
r.push(m.get(NaN), m.get(0), [NaN].includes(NaN), [NaN].indexOf(NaN), [-0].includes(0));
var ws = Object.isFrozen(o);
r.push(ws);
throw new Error(JSON.stringify(r));
