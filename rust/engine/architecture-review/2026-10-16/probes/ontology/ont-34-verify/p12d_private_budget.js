function make() { class C { #x = 1; getX() { return this.#x; } } return new C(); }
for (var i = 0; i < 20000; i++) make().getX();
var n = 0, err = 'none';
try { for (var j = 0; j < 70000; j++) { var o = {}; o[Symbol()] = 1; n = j + 1; } } catch (e) { err = e.name + ':' + e.message; }
throw new Error('after 20000 class evals, symbol keys minted=' + n + ' err=' + err);
