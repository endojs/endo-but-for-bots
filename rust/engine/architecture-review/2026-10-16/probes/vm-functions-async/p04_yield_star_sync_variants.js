const log = [];
async function drain(name, g) { try { for await (const v of g) log.push(name + ':' + (typeof v === 'object' ? 'obj' : v)); } catch (e) { log.push(name + ' threw ' + e); } }
(async function () {
  function* sg() { yield 1; yield Promise.resolve(2); }
  await drain('gen', (async function* () { yield* sg(); })());
  const custom = { [Symbol.iterator]() { let i = 0; return { next() { return i++ ? { done: true, value: 'R' } : { value: 3, done: false }; } }; } };
  await drain('customNextOnly', (async function* () { const r = yield* custom; log.push('ret=' + r); })());
  const custom2 = { [Symbol.iterator]() { let i = 0; return { next() { return i++ ? { done: true, value: 'R' } : { value: 4, done: false }; }, return(v) { return { done: true, value: v }; }, throw(e) { throw e; } }; } };
  await drain('customFull', (async function* () { const r = yield* custom2; log.push('ret=' + r); })());
  // return() forwarding through yield* to a sync generator inside try/finally
  function* fin() { try { yield 'x'; yield 'y'; } finally { log.push('fin-cleanup'); } }
  const ag = (async function* () { yield* fin(); })();
  log.push('n1=' + (await ag.next()).value);
  const rr = await ag.return('done');
  log.push('ret:' + rr.value + ',' + rr.done);
  report(JSON.stringify(log));
})();
