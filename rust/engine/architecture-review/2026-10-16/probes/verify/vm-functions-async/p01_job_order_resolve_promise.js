const log = [];
const p = Promise.resolve();
new Promise(function (r) { r(p); }).then(function () { log.push('a'); });
p.then(function () { log.push('b'); }).then(function () { log.push('c'); }).then(function () { log.push('d'); }).then(function () { log.push('e'); });
after(20, function () { report(JSON.stringify(log)); });
