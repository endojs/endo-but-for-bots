const out = [];
globalThis.hit = 0;
function attempt(label, f) { try { const r = f(); out.push(label + ':' + typeof r + ':hit=' + globalThis.hit); } catch (e) { out.push(label + ':' + e.constructor.name + ':hit=' + globalThis.hit); } }
attempt('body-close', function () { return Function('}); globalThis.hit++; (function(){'); });
attempt('param-close', function () { return Function('a) { globalThis.hit++; }; (function(b', 'return 1'); });
attempt('param-comment', function () { return Function('/*', '*/){'); });
attempt('body-comment-close', function () { return Function('', '}/*'); });
attempt('gen-body-close', function () { const GF = Object.getPrototypeOf(function* () {}).constructor; return GF('}); globalThis.hit++; (function*(){'); });
attempt('ok', function () { return Function('a', 'b', 'return a+b'); });
throw new Error(JSON.stringify(out));
