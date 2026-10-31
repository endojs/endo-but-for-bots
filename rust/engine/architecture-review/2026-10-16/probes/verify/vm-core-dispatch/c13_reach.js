var out = [];
function c(name, f) { var r; try { r = String(f()); } catch (e) { r = "throw " + e.name + ":" + e.message; } out.push(name + "=" + r); }
c("forin-null", function () { var n = 0; for (var k in null) n++; return n; });
c("forin-undef", function () { var n = 0; for (var k in undefined) n++; return n; });
c("forin-str", function () { var n = 0; for (var k in "ab") n++; return n; });
c("forin-sym", function () { var n = 0; for (var k in Symbol()) n++; return n; });
c("new-gen", function () { function* g() {} try { new g(); return "no"; } catch (e) { return e.name; } });
c("new-asyncgen", function () { async function* g() {} try { new g(); return "no"; } catch (e) { return e.name; } });
c("reflect-construct-gen", function () { function* g() {} try { Reflect.construct(g, []); return "no"; } catch (e) { return e.name; } });
c("reflect-construct-gen-nt", function () { function* g() {} function F(){} try { Reflect.construct(F, [], g); return "ok"; } catch (e) { return e.name; } });
c("eval-super", function () { var o = { m() { return eval("super.toString === Object.prototype.toString"); } }; return o.m(); });
c("eval-super-arrow", function () { var o = { m() { return (() => eval("super.toString === Object.prototype.toString"))(); } }; return o.m(); });
c("super-in-getter-defineProperty", function () { var o = { get x() { return super.toString === Object.prototype.toString; } }; var d = Object.getOwnPropertyDescriptor(o, "x"); var p = {}; Object.defineProperty(p, "y", d); return p.y; });
c("method-borrowed", function () { var o = { m() { return super.hasOwnProperty === Object.prototype.hasOwnProperty; } }; var m = o.m; return m.call(null); });
c("super-set-in-class-static", function () { class A { static m() { super.q = 1; return this.q; } } return A.m(); });
throw new Error(JSON.stringify(out));
