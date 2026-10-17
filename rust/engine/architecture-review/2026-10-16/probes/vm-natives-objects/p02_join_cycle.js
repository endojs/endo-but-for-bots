const a = [1]; a.push(a);
let r;
try { r = a.join('-'); } catch (e) { r = 'caught ' + e.name; }
let r2;
const o = { toString() { return String([o]); } };
try { r2 = String(o); } catch (e) { r2 = 'caught ' + e.name; }
throw new Error(JSON.stringify([r, r2]));
