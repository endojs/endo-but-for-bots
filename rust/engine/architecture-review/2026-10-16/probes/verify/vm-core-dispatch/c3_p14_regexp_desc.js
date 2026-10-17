var out = [];
function c(name, f) { var r; try { r = String(f()); } catch (e) { r = "throw " + e.name + ":" + e.message; } out.push(name + "=" + r); }
c("flags-desc", function () { var d = Object.getOwnPropertyDescriptor(RegExp.prototype, "flags"); return d && typeof d.get; });
c("source-desc", function () { var d = Object.getOwnPropertyDescriptor(RegExp.prototype, "source"); return d && typeof d.get; });
c("flags-getter-call", function () { var d = Object.getOwnPropertyDescriptor(RegExp.prototype, "flags"); return d.get.call(/x/gi); });
c("reflect-get-source", function () { return Reflect.get(RegExp.prototype, "source", /zz/); });
c("reflect-get-global", function () { return Reflect.get(RegExp.prototype, "global", /zz/g); });
c("subclass-flags", function () { class R extends RegExp {} return new R("a", "gy").flags; });
c("obj-create-flags", function () { var o = Object.create(/a/g); try { return o.flags; } catch (e) { return e.name; } });
throw new Error(JSON.stringify(out));
