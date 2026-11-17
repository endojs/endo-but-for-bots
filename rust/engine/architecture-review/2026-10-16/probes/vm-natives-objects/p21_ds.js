const r = {};
const P = DisposableStack.prototype;
r.disposedDesc = String(Object.getOwnPropertyDescriptor(P, 'disposed'));
r.symDispose = typeof P[Symbol.dispose];
r.symAlias = P[Symbol.dispose] === P.dispose;
r.tag = P[Symbol.toStringTag];
r.asyncSym = typeof AsyncDisposableStack.prototype[Symbol.asyncDispose];
const s = new DisposableStack();
r.disposedVal = s.disposed;
const log = [];
s.use({ [Symbol.dispose]() { log.push('use'); } });
s.adopt(5, (v) => log.push('adopt' + v));
s.defer(() => log.push('defer'));
s.dispose();
r.order = log.join();
r.after = s.disposed;
try { s.use({ [Symbol.dispose]() {} }); r.useAfter = 'nothrow'; } catch (e) { r.useAfter = e.name; }
try { new DisposableStack().use(5); r.usePrim = 'nothrow'; } catch (e) { r.usePrim = e.name; }
const s2 = new DisposableStack();
s2.defer(() => { throw new Error('a'); });
s2.defer(() => { throw new Error('b'); });
try { s2.dispose(); } catch (e) { r.supp = [e.name, e.error && e.error.message, e.suppressed && e.suppressed.message]; }
Number.prototype[Symbol.dispose] = function () {};
try { new DisposableStack().use(5); r.usePrimWithProto = 'accepted'; } catch (e) { r.usePrimWithProto = e.name; }
throw new Error(JSON.stringify(r));
