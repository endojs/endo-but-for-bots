class B { get x() { return 42; } } class C extends B { m() { return eval('super.x'); } }
var r; function F() { r = eval('new.target') === F; } new F();
class P { #x = 7; m() { return eval('this.#x'); } }
throw new Error(JSON.stringify([new C().m(), r, new P().m()]));
