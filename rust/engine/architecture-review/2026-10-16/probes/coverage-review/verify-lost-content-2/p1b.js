var out = [];
Number.prototype[Symbol.dispose] = function () { out.push("num-dispose:" + typeof this); };
try { var s = new DisposableStack(); var r = s.use(5); out.push("use(5)=" + r); s.dispose(); } catch (e) { out.push("use(5):" + e.name); }
try { { using x = 5; out.push("using5:ok"); } } catch (e) { out.push("using5:" + e.name); }
delete Number.prototype[Symbol.dispose];
try { var s2 = new DisposableStack(); s2.use(5); out.push("use(5)-noproto:accepted"); } catch (e) { out.push("use(5)-noproto:" + e.name); }
var o = { [Symbol.asyncDispose]: 42, [Symbol.dispose]() { out.push("sync-fallback"); } };
try { var a = new AsyncDisposableStack(); a.use(o); out.push("async-use42:accepted"); } catch (e) { out.push("async-use42:" + e.name); }
var o2 = { [Symbol.asyncDispose]: null, [Symbol.dispose]() {} };
try { var a2 = new AsyncDisposableStack(); a2.use(o2); out.push("async-use-null:accepted"); } catch (e) { out.push("async-use-null:" + e.name); }
var o3 = { [Symbol.dispose]: 42 };
try { var s3 = new DisposableStack(); s3.use(o3); out.push("sync-use42:accepted"); } catch (e) { out.push("sync-use42:" + e.name); }
console.log(out.join(" | "));
