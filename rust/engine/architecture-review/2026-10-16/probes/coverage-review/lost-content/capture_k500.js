var K = 500, N = 800, names = [];
for (var i = 0; i < K; i++) names.push("v" + i);
var outer = Function("var " + names.map(function (s) { return s + " = 0"; }).join(", ") +
  "; return function () { " + names.join("; ") + "; };");
for (var j = 0; j < N; j++) outer();
