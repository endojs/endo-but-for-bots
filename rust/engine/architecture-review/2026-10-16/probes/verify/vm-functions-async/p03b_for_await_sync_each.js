const log = [];
async function t(name, f) { try { await f(); } catch (e) { log.push(name + ' threw ' + e); } }
(async function () {
  await t('array', async function () { for await (const v of [Promise.resolve('a')]) log.push(typeof v === 'string' ? v : 'obj'); });
  await t('gen', async function () { function* sg() { yield Promise.resolve('b'); } for await (const v of sg()) log.push(typeof v === 'string' ? v : 'obj'); });
  await t('custom', async function () { const it = { [Symbol.iterator]() { let i = 0; return { next() { return i++ ? { done: true } : { value: Promise.resolve('c'), done: false }; } }; } }; for await (const v of it) log.push(typeof v === 'string' ? v : 'obj'); });
  await t('set', async function () { for await (const v of new Set([Promise.resolve('d')])) log.push(typeof v === 'string' ? v : 'obj'); });
  await t('plain', async function () { for await (const v of ['e']) log.push(v); });
  report(JSON.stringify(log));
})();
