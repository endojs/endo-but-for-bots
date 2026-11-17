var out = [];
var o = { [Symbol.asyncDispose]: 42, [Symbol.dispose]() { out.push("sync-fallback"); } };
async function f() { try { { await using y = o; out.push("awaitusing:ok"); } } catch (e) { out.push("awaitusing:" + e.name); } }
f().then(function(){ throw new Error(out.join(" | ")); });
