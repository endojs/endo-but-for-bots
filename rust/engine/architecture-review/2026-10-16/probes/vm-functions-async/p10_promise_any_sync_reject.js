const log = [];
function Constructor(executor) {
  executor(function () { log.push('resolved?!'); }, function (error) {
    log.push('rejected errors=' + JSON.stringify(error.errors) + ' isArray=' + Array.isArray(error.errors));
  });
}
Constructor.resolve = function (v) { return v; };
const p1 = { then(f, r) { r('e1'); } };
const p2 = { then(f, r) { r('e2'); } };
Promise.any.call(Constructor, [p1, p2]);
// native promise version for comparison (asynchronous rejections)
Promise.any([Promise.reject('n1'), Promise.reject('n2')]).catch(function (e) { log.push('native errors=' + JSON.stringify(e.errors)); });
after(10, function () { report(JSON.stringify(log)); });
