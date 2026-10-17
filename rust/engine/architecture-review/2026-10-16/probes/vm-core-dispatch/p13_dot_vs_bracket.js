var out = [];
function c(name, f) { var r; try { r = String(f()); } catch (e) { r = "throw " + e.name + ":" + e.message; } out.push(name + "=" + r); }
c("regexp-source-own-dot", function () { var r = /a/g; Object.defineProperty(r, "source", { value: "own" }); return r.source; });
c("regexp-source-own-bracket", function () { var r = /a/g; Object.defineProperty(r, "source", { value: "own" }); var k = "source"; return r[k]; });
c("regexp-flags-proxy-recv", function () { var r = /a/g; return Reflect.get(RegExp.prototype, "flags", r); });
c("locale-own-bracket", function () { var l = new Intl.Locale("en-US"); Object.defineProperty(l, "language", { value: "own" }); var k = "language"; return l[k]; });
c("dur-own-bracket", function () { var d = Temporal.Duration.from({ days: 1 }); Object.defineProperty(d, "days", { value: 42 }); var k = "days"; return d[k]; });
throw new Error(JSON.stringify(out));
