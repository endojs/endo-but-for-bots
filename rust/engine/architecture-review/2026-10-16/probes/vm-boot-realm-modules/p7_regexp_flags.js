// Natives that read a RegExp's `flags`/`source` accessors implicitly. The
// program never spells those names.
var out = [];
function t(f) { try { out.push(String(f())); } catch (e) { out.push(e.name + ": " + e.message); } }
t(function () { return "aXa".replaceAll(/a/g, "b"); });
t(function () { return [..."aXa".matchAll(/a/g)].length; });
t(function () { return "a,b".split(/,/).length; });
t(function () { return new RegExp(/a/g).global; });
t(function () { return String(new RegExp(/a/gi)); });
throw new Error(JSON.stringify(out));
