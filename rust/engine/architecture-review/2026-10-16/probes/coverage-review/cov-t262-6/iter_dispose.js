const out = [];
const IterProto = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
const AsyncIterProto = Object.getPrototypeOf(Object.getPrototypeOf((async function*(){})).prototype);
out.push(typeof IterProto[Symbol.dispose], typeof AsyncIterProto[Symbol.asyncDispose]);
out.push(String(Reflect.ownKeys(AsyncIterProto).map(String)));
out.push(String(Reflect.ownKeys(IterProto).filter(k => typeof k === 'symbol').map(String)));
let closed = false;
const it = { __proto__: IterProto, next() { return {done:true}; }, return() { closed = true; return {}; } };
try { { using x = it; } out.push('using ok closed=' + closed); } catch (e) { out.push('using threw ' + e.constructor.name + ': ' + e.message); }
try { { using y = [1,2].values(); } out.push('values ok'); } catch (e) { out.push('values threw ' + e.constructor.name); }
const print = s => { throw new Error(s); };
print(JSON.stringify(out));
