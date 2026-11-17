var out = [];
function c(name, f) { var r; try { r = String(f()); } catch (e) { r = "throw " + e.name + ":" + e.message; } out.push(name + "=" + r); }
c("super-eval", function () { var o = { __proto__: { x: "px" }, m() { return eval("super.x"); } }; return o.m(); });
c("super-eval-computed", function () { var o = { __proto__: { x: "px" }, m() { return eval("super['x']"); } }; return o.m(); });
c("super-field", function () { class B { get y() { return "by"; } } class A extends B { x = super.y; } return new A().x; });
c("super-field-arrow", function () { class B { get y() { return "by"; } } class A extends B { f = () => super.y; } return new A().f(); });
c("super-static-block", function () { var r; class B { static s = "bs"; } class A extends B { static { r = super.s; } } return r; });
c("super-getter", function () { var o = { __proto__: { x: "px" }, get g() { return super.x; } }; return o.g; });
c("super-computed-field", function () { class B { get y() { return "by"; } } class A extends B { ["k"] = super["y"]; } return new A().k; });
c("super-in-eval-arrow", function () { class B { m() { return "bm"; } } class A extends B { m() { return (() => eval("super.m()"))(); } } return new A().m(); });
c("new-target-eval", function () { function F() { return eval("new.target") === F; } return new F(); });
c("new-target-arrow-in-eval", function () { function F() { return eval("(() => new.target)()") === F; } return new F(); });
c("gen-new-target", function () { function* g() { yield new.target; } return g().next().value; });
c("super-prop-in-method-copied", function () { var o = { __proto__: { x: "px" }, m() { return super.x; } }; var f = o.m; return f.call({}); });
c("super-call-in-eval", function () { class B { constructor() { this.v = 1; } } class A extends B { constructor() { eval("super()"); } } return new A().v; });
throw new Error(JSON.stringify(out));
