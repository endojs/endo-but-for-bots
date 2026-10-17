var out = [];
class B { get x() { return 42; } }
class C extends B { m() { return eval("super.x"); } }
out.push(new C().m());
var r; function F() { r = eval("new.target") === F; } new F(); out.push(r);
class P { #x = 7; m() { return eval("this.#x"); } }
out.push(new P().m());
throw new Error(JSON.stringify(out));
