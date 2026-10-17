var out = [];
var p = new Proxy({}, { apply: function () { return 'trap ran'; } });
try { out.push('call:' + p()); } catch (e) { out.push('call threw ' + e.name); }
try { out.push('typeof:' + typeof p); } catch (e) { out.push('typeof threw'); }
try { out.push('new:' + new (new Proxy({}, { construct: function () { return {}; } }))()); } catch (e) { out.push('new threw ' + e.name); }
try { out.push('Reflect.apply:' + Reflect.apply(p, null, [])); } catch (e) { out.push('Reflect.apply threw ' + e.name); }
try { out.push('call.call:' + Function.prototype.call.call(p)); } catch (e) { out.push('call.call threw ' + e.name); }
throw new Error(out.join(' | '));
