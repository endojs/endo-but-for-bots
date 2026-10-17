var re3 = new RegExp("b{" + Number.MAX_SAFE_INTEGER + "," + Number.MAX_SAFE_INTEGER + "}");
var c = re3.test("b");
throw new Error("ok")
