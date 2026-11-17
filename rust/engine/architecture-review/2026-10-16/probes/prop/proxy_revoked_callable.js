var out = [];
var r = Proxy.revocable(function () {}, {}); r.revoke();
out.push('typeof revoked fn proxy: ' + typeof r.proxy);
var r2 = Proxy.revocable(class {}, {}); r2.revoke();
try { new r2.proxy(); } catch (e) { out.push('new revoked: ' + e.name + ' ' + e.message); }
try { r.proxy(); } catch (e) { out.push('call revoked: ' + e.name); }
// Array.prototype.map with revoked proxy callback: IsCallable must be true, then Call throws
try { [1].map(r.proxy); } catch (e) { out.push('map revoked: ' + e.name + ' ' + e.message); }
// a callable proxy over a non-callable: Function.prototype.toString
var r3 = Proxy.revocable({}, {}); r3.revoke(); out.push('typeof revoked obj proxy: ' + typeof r3.proxy);
throw new Error(out.join(' | '));
