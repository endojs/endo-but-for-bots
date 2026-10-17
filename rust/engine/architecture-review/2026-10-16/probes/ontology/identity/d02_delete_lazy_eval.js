var o = JSON.parse('{"sumPrecise":1}');
var k = Object.keys(o)[0];
var r1 = delete Math[k];
var t = (0, eval)("typeof Math[" + JSON.stringify(k) + "]");
var t2 = (0, eval)("typeof Math.sumPrecise");
throw new Error(JSON.stringify([r1, t, t2]));
