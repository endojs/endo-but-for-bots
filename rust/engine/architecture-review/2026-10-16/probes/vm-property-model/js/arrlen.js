var R = {};
function t(name, f) { try { R[name] = f(); } catch (e) { R[name] = 'throws ' + e.name; } }
t('assign_frac', function () { var a = [1, 2, 3]; a.length = 1.5; return a.length; });
t('assign_neg', function () { var a = [1, 2, 3]; a.length = -1; return a.length; });
t('assign_2_32', function () { var a = [1, 2, 3]; a.length = 4294967296; return a.length; });
t('assign_str', function () { var a = [1, 2, 3]; a.length = '2'; return a.length; });
t('assign_obj', function () { var n = 0; var a = [1, 2, 3]; a.length = { valueOf: function () { n++; return 1; } }; return a.length + ':' + n; });
t('reflect_set_frac', function () { var a = [1, 2, 3]; return Reflect.set(a, 'length', 1.5); });
t('computed_frac', function () { var a = [1, 2, 3]; var k = 'length'; a[k] = 1.5; return a.length; });
t('strict_frozen_len', function () { 'use strict'; var a = Object.freeze([1]); try { a.length = 0; return 'nothrow'; } catch (e) { return e.name; } });
t('proxy_len_frac', function () { var a = new Proxy([1, 2, 3], {}); a.length = 1.5; return a.length; });
throw new Error(JSON.stringify(R));
