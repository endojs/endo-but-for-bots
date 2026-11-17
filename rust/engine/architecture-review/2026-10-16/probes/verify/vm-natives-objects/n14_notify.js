let r;
try { r = Atomics.notify(new Int32Array(4), 0, 1); } catch (e) { r = e.name; }
throw new Error(JSON.stringify(['notify-nonshared', r]));
