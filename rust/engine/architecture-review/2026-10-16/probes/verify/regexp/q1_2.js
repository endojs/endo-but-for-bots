var re2 = new RegExp("b{" + Number.MAX_SAFE_INTEGER + ",}?");
var b = re2.test("a");
throw new Error("ok")
