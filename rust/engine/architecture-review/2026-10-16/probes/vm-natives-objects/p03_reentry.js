const r = [];
function f() { f(); }
try { f(); r.push('no'); } catch (e) { r.push('js:' + e.name); }
function g() { return [1].map(g); }
try { g(); r.push('no'); } catch (e) { r.push('map:' + e.name); }
throw new Error(JSON.stringify(r));
