var r = [];
var regExp = /(?:)/m;
var regExpTarget = new Proxy(regExp, {});
var regExpProxy = new Proxy(regExpTarget, {});
r.push(Reflect.has(regExpProxy, "ignoreCase"), Reflect.has(regExp, "ignoreCase"), "ignoreCase" in RegExp.prototype, Symbol.replace in regExpProxy, "lastIndex" in Object.create(regExpProxy));
var functionTarget = new Proxy(function() {}, {});
var functionProxy = new Proxy(functionTarget, {});
r.push("name" in functionProxy, "length" in Object.create(functionProxy));
throw new Error(JSON.stringify(r));
