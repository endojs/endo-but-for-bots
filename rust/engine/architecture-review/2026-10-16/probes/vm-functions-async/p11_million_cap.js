// Promise.race consumes an iterator of 1,000,001 elements (the same promise),
// reusing one result object so no per-step allocation hits the slot ceiling.
const p = Promise.resolve(7);
const r = { value: p, done: false };
const end = { value: undefined, done: true };
const it = { [Symbol.iterator]() { let i = 0; return { next() { return i++ < 1000001 ? r : end; } }; } };
try { Promise.race(it).then(function (v) { report('race settled ' + v); }); } catch (e) { report('caught ' + e); }
