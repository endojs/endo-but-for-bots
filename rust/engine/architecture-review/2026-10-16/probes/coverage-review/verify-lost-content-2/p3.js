var out = [];
var o = { [Symbol.asyncDispose]: 42, [Symbol.dispose]() { out.push("sync-fallback"); } };
async function f() { try { { await using y = o; out.push("awaitusing:ok"); } } catch (e) { out.push("awaitusing:" + e.name); } }
f();
var p = Promise.resolve(); for (var i = 0; i < 50; i++) p = p.then(function(){});
p.then(function () { if (out.join(",") === "awaitusing:TypeError") { for(;;){} } });
