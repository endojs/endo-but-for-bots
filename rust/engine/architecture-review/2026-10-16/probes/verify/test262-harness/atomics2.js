var r;
try { Atomics.notify(new Float64Array(4), 0); r = 'no throw'; } catch (e) { r = e.name; }
throw new Error(r);
