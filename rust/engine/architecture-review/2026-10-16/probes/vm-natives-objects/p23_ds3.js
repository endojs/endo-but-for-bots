const s = new DisposableStack();
const r = {};
r.dot = s.disposed;
r.reflect = Reflect.get(s, 'disposed');
r.inOp = 'disposed' in s;
const k = 'dispo' + 'sed';
r.computed = s[k];
Object.defineProperty(s, 'disposed', { value: 'shadow' });
r.shadowed = s.disposed;
r.shadowReflect = Reflect.get(s, 'disposed');
class D extends DisposableStack { get disposed() { return 'subclass'; } }
r.subclass = new D().disposed;
r.plain = ({ disposed: 7 }).disposed;
throw new Error(JSON.stringify(r));
