var out = {};
try { class A { #x = 7; m() { return eval('this.#x'); } } out.priv = new A().m(); } catch (e) { out.priv = String(e); }
try { class P { get v() { return 5; } } class C extends P { m() { return eval('super.v'); } } out.sup = new C().m(); } catch (e) { out.sup = String(e); }
try { function F() { return eval('new.target') === F; } out.nt = new F() instanceof F ? 'object' : 'other'; } catch (e) { out.nt = String(e); }
try { out.plain = eval('1+2'); } catch (e) { out.plain = String(e); }
throw new Error(JSON.stringify(out));
