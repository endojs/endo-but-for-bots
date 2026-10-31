var out = [];
function c(name, f) { var r; try { r = String(f()); } catch (e) { r = "throw " + e.name + ":" + e.message; } out.push(name + "=" + r); }
c("replaceAll", function () { return "aXa".replaceAll(/a/g, "b"); });
c("matchAll", function () { return [..."aba".matchAll(/a/g)].length; });
c("split", function () { return "a-b".split(/-/).join("|"); });
c("newRegExp-from-re", function () { return new RegExp(/x/gi).flags; });
c("toString", function () { return String(/x/gi); });
c("spread-flags", function () { var r = /x/gi; var k = "flags"; return r[k]; });
c("in-flags", function () { return "flags" in /x/; });
c("structuredish", function () { var r = /x/g; return JSON.stringify(Object.keys(Object.getOwnPropertyDescriptors(RegExp.prototype)).sort()); });
throw new Error(JSON.stringify(out));
