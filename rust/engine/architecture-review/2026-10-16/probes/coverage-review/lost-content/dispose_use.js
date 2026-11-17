var out = [];
// 1. DisposableStack.prototype.use with a primitive whose prototype has @@dispose
Number.prototype[Symbol.dispose] = function () { out.push("num-dispose"); };
try { var s = new DisposableStack(); var r = s.use(5); out.push("use(5)=" + r); s.dispose(); }
catch (e) { out.push("use(5):" + e.name); }
delete Number.prototype[Symbol.dispose];
// 2. AsyncDisposableStack.prototype.use with non-callable @@asyncDispose and callable @@dispose
var o = { [Symbol.asyncDispose]: 42, [Symbol.dispose]() { out.push("sync-fallback"); } };
try { var a = new AsyncDisposableStack(); a.use(o); out.push("async-use:accepted"); }
catch (e) { out.push("async-use:" + e.name); }
throw new Error(out.join(" | "));
