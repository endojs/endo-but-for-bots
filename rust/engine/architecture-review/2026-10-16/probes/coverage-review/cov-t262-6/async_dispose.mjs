const AsyncIterProto = Object.getPrototypeOf(Object.getPrototypeOf((async function*(){})).prototype);
const gen = (async function*(){})();
const r = [typeof AsyncIterProto[Symbol.asyncDispose], typeof gen[Symbol.asyncDispose], String(Reflect.ownKeys(AsyncIterProto).map(String))];
let status = 'pending';
try { await using a = gen; status = 'ok'; } catch (e) { status = 'threw ' + e.constructor.name + ': ' + e.message; }
r.push(status);
throw new Error(JSON.stringify(r));
