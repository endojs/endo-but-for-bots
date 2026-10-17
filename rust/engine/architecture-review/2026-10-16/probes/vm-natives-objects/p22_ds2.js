const s = new DisposableStack();
const r = { own: Object.getOwnPropertyNames(s), inProto: 'disposed' in DisposableStack.prototype, chain: [] };
let o = s; while (o) { const d = Object.getOwnPropertyDescriptor(o, 'disposed'); r.chain.push(d ? Object.keys(d).join('/') : '-'); o = Object.getPrototypeOf(o); }
const a = new AsyncDisposableStack(); r.asyncDisposed = a.disposed;
throw new Error(JSON.stringify(r));
