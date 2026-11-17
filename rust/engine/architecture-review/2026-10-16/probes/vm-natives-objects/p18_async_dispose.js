const log = [];
const s = new AsyncDisposableStack();
s.defer(async () => { log.push('a-start'); await null; await null; log.push('a-end'); });
s.defer(async () => { log.push('b-start'); await null; log.push('b-end'); throw new Error('boom'); });
let settled = 'pending';
s.disposeAsync().then(() => { settled = 'fulfilled'; log.push('settled-ok'); }, (e) => { settled = 'rejected:' + e.message; log.push('settled-err'); });
log.push('sync-after');
Promise.resolve().then(() => 0).then(() => 0).then(() => 0).then(() => 0).then(() => 0).then(() => 0).then(() => {
  throw new Error(JSON.stringify([log, settled]));
});
