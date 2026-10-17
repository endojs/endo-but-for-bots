var r = [];
r.push(Atomics.notify(new Int32Array(4), 0));
throw new Error(JSON.stringify(r));
