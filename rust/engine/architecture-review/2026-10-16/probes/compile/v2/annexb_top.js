var out = [];
out.push(typeof this === "object" ? "sloppy-this" : "strict-this");
if (true) function g(){ return 1; }
out.push(typeof g);
l: function h(){}
out.push(typeof h);
var x = 1; <!-- html open comment
x;
--> html close at line start
throw new Error(out.join());
