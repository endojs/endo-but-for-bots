var out = [];
function c(name, f) { var r; try { r = String(f()); } catch (e) { r = "throw " + e.name + ":" + e.message; } out.push(name + "=" + r); }
c("eval-super-call", function () { class B { constructor() { this.v = 1; } } class A extends B { constructor() { eval("super()"); } } return new A().v; });
c("eval-super-call-arrow", function () { class B { constructor() { this.v = 2; } } class A extends B { constructor() { (() => eval("super()"))(); } } return new A().v; });
c("arrow-super-call", function () { class B { constructor() { this.v = 3; } } class A extends B { constructor() { (() => super())(); } } return new A().v; });
c("eval-super-call-twice", function () { class B {} class A extends B { constructor() { super(); eval("super()"); } } return new A(); });
c("eval-super-call-in-method", function () { class B {} class A extends B { m() { return eval("super()"); } } return new A().m(); });
c("eval-super-call-in-base-ctor", function () { class A { constructor() { eval("super()"); } } return new A(); });
c("eval-super-call-indirect", function () { class B {} class A extends B { constructor() { (0, eval)("super()"); } } return new A(); });
c("eval-super-prop-ctor", function () { class B { get y() { return "by"; } } class A extends B { constructor() { super(); this.z = eval("super.y"); } } return new A().z; });
c("eval-new-target-ctor", function () { class B {} class A extends B { constructor() { super(); this.t = eval("new.target") === A; } } return new A().t; });
c("Function-super-call", function () { class B {} class A extends B { constructor() { super(); Function("super()"); } } return new A(); });
throw new Error(JSON.stringify(out));
