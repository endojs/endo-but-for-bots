var out = [];
function c(name, f) { var r; try { r = String(f()); } catch (e) { r = "throw " + e.name + ":" + e.message; } out.push(name + "=" + r); }
c("dur-own-shadow", function () { var d = Temporal.Duration.from({ days: 1 }); Object.defineProperty(d, "days", { value: 42 }); return d.days; });
c("dur-proto-deleted", function () { var d = Temporal.Duration.from({ days: 1 }); delete Temporal.Duration.prototype.days; return d.days; });
c("plain-proto-redefined", function () { var p = Temporal.PlainDate.from("2020-01-02"); Object.defineProperty(Temporal.PlainDate.prototype, "year", { get: function () { return "patched"; } }); return p.year; });
c("instant-own", function () { var i = Temporal.Instant.fromEpochMilliseconds(5); Object.defineProperty(i, "epochMilliseconds", { value: "own" }); return i.epochMilliseconds; });
c("locale-own", function () { var l = new Intl.Locale("en-US"); Object.defineProperty(l, "language", { value: "own" }); return l.language; });
c("locale-proto-del", function () { var l = new Intl.Locale("en-US"); delete Intl.Locale.prototype.region; return l.region; });
c("collator-compare-own", function () { var co = new Intl.Collator(); Object.defineProperty(co, "compare", { value: "own" }); return co.compare; });
c("regexp-source-own", function () { var r = /a/g; Object.defineProperty(r, "source", { value: "own" }); return r.source; });
c("regexp-global-del", function () { var r = /a/g; delete RegExp.prototype.global; return r.global; });
throw new Error(JSON.stringify(out));
