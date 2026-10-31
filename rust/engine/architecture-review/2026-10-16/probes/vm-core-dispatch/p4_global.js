var out = [];
function c(name, f) { var r; try { r = String(f()); } catch (e) { r = "throw " + e.name + ":" + e.message; } out.push(name + "=" + r); }
c("proto-null", function () { return Object.getPrototypeOf(globalThis) === null; });
c("instanceof-Object", function () { return globalThis instanceof Object; });
c("isPrototypeOf", function () { return Object.prototype.isPrototypeOf(globalThis); });
c("this-hasOwnProperty", function () { return this.hasOwnProperty("out"); });
c("in-toString", function () { return "toString" in globalThis; });
c("bare-toString-typeof", function () { return typeof toString; });
c("String-global", function () { return String(globalThis); });
throw new Error(JSON.stringify(out));
