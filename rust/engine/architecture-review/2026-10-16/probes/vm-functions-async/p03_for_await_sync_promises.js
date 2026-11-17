const log = [];
(async function () {
  for await (const v of [Promise.resolve('a')]) log.push(typeof v === 'string' ? v : 'obj');
  function* sg() { yield Promise.resolve('b'); }
  for await (const v of sg()) log.push(typeof v === 'string' ? v : 'obj');
  const it = { [Symbol.iterator]() { let i = 0; return { next() { return i++ ? { done: true } : { value: Promise.resolve('c'), done: false }; } }; } };
  for await (const v of it) log.push(typeof v === 'string' ? v : 'obj');
  for await (const v of new Set([Promise.resolve('d')])) log.push(typeof v === 'string' ? v : 'obj');
  // rejection in a sync-iterator value closes the iterator (ES2025 AsyncFromSyncIteratorContinuation)
  let closed = false;
  const it2 = { [Symbol.iterator]() { return { next() { return { value: Promise.reject('boom'), done: false }; }, return() { closed = true; return {}; } }; } };
  try { for await (const v of it2) log.push('v'); } catch (e) { log.push('caught:' + e + ':closed=' + closed); }
  report(JSON.stringify(log));
})().catch(function (e) { report('outer ' + e); });
