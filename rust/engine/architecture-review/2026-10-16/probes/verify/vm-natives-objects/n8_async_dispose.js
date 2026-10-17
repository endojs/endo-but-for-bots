var R = { log: [], settled: 'pending' };
var s = new AsyncDisposableStack();
s.defer(async function () { R.log.push('a-start'); await null; await null; R.log.push('a-end'); });
s.defer(async function () { R.log.push('b-start'); await null; R.log.push('b-end'); throw new Error('boom'); });
s.disposeAsync().then(function () { R.settled = 'fulfilled'; R.log.push('settled'); }, function (e) { R.settled = 'rejected:' + e.message; R.log.push('settled'); });
R.log.push('sync-after');
var p = Promise.resolve();
for (var i = 0; i < 20; i++) p = p.then(function () {});
p.then(function () { throw new Error(JSON.stringify(R)); });
