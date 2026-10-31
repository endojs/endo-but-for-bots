// Promise.prototype.finally hands `then` two closures. Are engine-internal
// fields visible on them as string-named own properties?
var seen = null;
var thenable = Promise.resolve(1);
thenable.then = function (a, b) { seen = [Reflect.ownKeys(a).map(String), Reflect.ownKeys(b).map(String)]; };
Promise.prototype.finally.call(thenable, function () {});
throw new Error(JSON.stringify(seen));
