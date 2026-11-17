(async function () { for await (var x of [Promise.resolve(1)]) { if (typeof x !== 'number') (function r() { r(); })(); } })();
