'use strict';
const out = [];
function t(name, f) { try { out.push(name + '=' + f()); } catch (e) { out.push(name + '!' + (e && e.constructor && e.constructor.name) + ':' + (e && e.message)); } }
class A { constructor() { this.x = 1; } }
t('class-no-new', function () { return A(); });
class B extends A { constructor() { this.y = 1; super(); } }
t('derived-this-tdz', function () { return new B(); });
class C extends A { constructor() { return undefined; } }
t('derived-no-super', function () { return new C(); });
function NT() { return new.target === NT; }
t('new.target', function () { return new NT() instanceof NT ? 'obj' : 'x'; });
t('new.target-call', function () { return NT(); });
t('spread-5000', function () { return Math.max(...new Array(5000).fill(1)); });
t('apply-5000', function () { return Math.max.apply(null, new Array(5000).fill(2)); });
t('apply-100000', function () { return Math.max.apply(null, new Array(100000).fill(3)); });
t('user-spread-5000', function () { function f() { return arguments.length; } return f(...new Array(5000).fill(1)); });
t('bind-call', function () { return (function (a, b) { return this.k + a + b; }).bind({ k: 1 }, 2)(3); });
t('bind-name-len', function () { const b = function foo(a, b, c) {}.bind(null, 1); return b.name + '/' + b.length; });
t('call-proxy', function () { return new Proxy(function () { return 7; }, {}).call(null); });
t('ptc', function () { function r(n) { return n === 0 ? 'done' : r(n - 1); } return r(100000); });
throw new Error(JSON.stringify(out));
