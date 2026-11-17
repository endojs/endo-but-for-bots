var re1 = new RegExp("b{" + Number.MAX_SAFE_INTEGER + "}", "u");
var a = re1.test("");
var re2 = new RegExp("b{" + Number.MAX_SAFE_INTEGER + ",}?");
var b = re2.test("a");
var re3 = new RegExp("b{" + Number.MAX_SAFE_INTEGER + "," + Number.MAX_SAFE_INTEGER + "}");
var c = re3.test("b");
throw new Error(JSON.stringify([a,b,c]));
