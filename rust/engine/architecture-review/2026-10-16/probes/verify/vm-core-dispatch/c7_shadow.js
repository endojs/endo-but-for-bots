var out = [];
var x = "global";
function f() { var x = "outer"; { let x = "inner"; out.push(eval("x")); } return eval("x"); }
out.push(f());
function g() { var y = "outer"; { let y = "inner"; } with ({}) { return y; } }
out.push(g());
function h() { var z = "outer"; for (let z = 0; z < 1; z++) {} return (0, function(){ return typeof z; })() + "/" + eval("z"); }
try { out.push(h()); } catch (e) { out.push("h throw " + e.message); }
throw new Error(JSON.stringify(out));
