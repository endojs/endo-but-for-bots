var out = [];
function c(name, f) { var r; try { r = String(f()); } catch (e) { r = "throw " + e.name + ":" + e.message; } out.push(name + "=" + r); }
c("method", function () { return ({ m() { return eval("typeof new.target"); } }).m(); });
c("getter", function () { return ({ get g() { return eval("typeof new.target"); } }).g; });
c("generator", function () { function* g() { yield eval("typeof new.target"); } return g().next().value; });
c("async-fn-sync-part", function () { var r; async function f() { r = eval("typeof new.target"); } f(); return r; });
c("class-method", function () { class A { m() { return eval("typeof new.target"); } } return new A().m(); });
c("plain-fn-call", function () { function f() { return eval("typeof new.target"); } return f(); });
c("plain-fn-new", function () { function F() { this.t = eval("typeof new.target"); } return new F().t; });
c("arrow-in-method", function () { return ({ m() { return (() => eval("typeof new.target"))(); } }).m(); });
c("global", function () { return (0, eval)("1"); });
throw new Error(JSON.stringify(out));
