var re1 = new RegExp("b{" + Number.MAX_SAFE_INTEGER + "}", "u");
var a = re1.test("");
throw new Error("ok")
