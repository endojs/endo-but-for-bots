var r = [];
function t(l, f) { try { r.push(l + ':' + f()); } catch (e) { r.push(l + ':' + e.name); } }
var p = new Proxy({}, { apply: function () { return 'trap ran'; } });
t('call_nonfn', function () { return p(); });
t('reflect_apply_nonfn', function () { return Reflect.apply(p, null, []); });
t('fcall_nonfn', function () { return Function.prototype.call.call(p); });
t('typeof_nonfn', function () { return typeof p; });
var rv = Proxy.revocable(function () {}, {}); rv.revoke();
t('revoked_typeof', function () { return typeof rv.proxy; });
t('revoked_call', function () { return rv.proxy(); });
t('revoked_isArray_cb', function () { return [1].map(rv.proxy); });
t('revoked_then', function () { var out = 'none'; Promise.resolve(1).then(rv.proxy); return 'scheduled'; });
t('revoked_bind', function () { return typeof Function.prototype.bind.call(rv.proxy); });
throw new Error(r.join(' | '));
