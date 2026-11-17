var n = 0, err = 'none';
function make() { class C { #x = 1; getX() { return this.#x; } } return new C(); }
try { for (var i = 0; i < 70000; i++) { make().getX(); n = i + 1; } } catch (e) { err = e.name + ':' + e.message; }
throw new Error('private: n=' + n + ' err=' + err);
