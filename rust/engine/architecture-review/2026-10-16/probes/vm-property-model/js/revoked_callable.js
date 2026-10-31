var r = Proxy.revocable(function () { return 1; }, {}); r.revoke();
var out = ['typeof:' + typeof r.proxy];
var log = [];
Promise.resolve(42).then(r.proxy).then(function (v) { log.push('fulfilled:' + v); }, function (e) { log.push('rejected:' + e.name); });
Promise.resolve().then(function () {}).then(function () {}).then(function () {}).then(function () { throw new Error(out.concat(log).join(' | ')); });
