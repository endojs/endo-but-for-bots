var o = JSON.parse('{"sumPrecise":1}');
var k = Object.keys(o)[0];
var r1 = delete Math[k];
var t = typeof Math[k];
var has = Object.getOwnPropertyNames(Math).indexOf(k) >= 0;
throw new Error(JSON.stringify([r1, t, has]));
