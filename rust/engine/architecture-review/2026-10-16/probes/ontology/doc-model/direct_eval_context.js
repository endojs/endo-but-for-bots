// Direct eval of new.target / super / private names: needs SourceCompiler::compile_eval_units.
const out = {};
try { function F() { return eval('new.target') === F; } out.newTarget = new F() instanceof F ? 'object' : 'x'; out.newTarget2 = (function G(){ return eval('new.target'); }).call({}) === undefined; } catch (e) { out.newTarget = String(e); }
try { class A { #x = 7; m() { return eval('this.#x'); } } out.priv = new A().m(); } catch (e) { out.priv = String(e); }
try { class P { get v() { return 5; } } class C extends P { m() { return eval('super.v'); } } out.sup = new C().m(); } catch (e) { out.sup = String(e); }
throw new Error(JSON.stringify(out));
