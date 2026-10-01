// A3 review deep: untrapped-array-values at 999 (base ceiling 1998)
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
Array.from(Array.prototype.values.call(wrap([1, 2], 999))).join()
// ---
// A3 review deep: untrapped-array-values at 1997 (base ceiling 1998)
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
Array.from(Array.prototype.values.call(wrap([1, 2], 1997))).join()
// ---
// A3 review deep: untrapped-array-values at 1998 (base ceiling 1998)
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
Array.from(Array.prototype.values.call(wrap([1, 2], 1998))).join()
// ---
// A3 review deep: untrapped-array-values at 1999 (base ceiling 1998)
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
Array.from(Array.prototype.values.call(wrap([1, 2], 1999))).join()
// ---
// A3 review deep: untrapped-array-values at 2000 (base ceiling 1998)
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
Array.from(Array.prototype.values.call(wrap([1, 2], 2000))).join()
// ---
// A3 review deep: untrapped-string-values at 999 (base ceiling 1998)
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
Array.from(Array.prototype.values.call(wrap(new String('ab'), 999))).join()
// ---
// A3 review deep: untrapped-string-values at 1997 (base ceiling 1998)
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
Array.from(Array.prototype.values.call(wrap(new String('ab'), 1997))).join()
// ---
// A3 review deep: untrapped-string-values at 1998 (base ceiling 1998)
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
Array.from(Array.prototype.values.call(wrap(new String('ab'), 1998))).join()
// ---
// A3 review deep: untrapped-string-values at 1999 (base ceiling 1998)
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
Array.from(Array.prototype.values.call(wrap(new String('ab'), 1999))).join()
// ---
// A3 review deep: untrapped-string-values at 2000 (base ceiling 1998)
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
Array.from(Array.prototype.values.call(wrap(new String('ab'), 2000))).join()
// ---
// A3 review deep: untrapped-spread at 1007 (base ceiling 2014)
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
[...wrap([1, 2], 1007)].join()
// ---
// A3 review deep: untrapped-spread at 2013 (base ceiling 2014)
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
[...wrap([1, 2], 2013)].join()
// ---
// A3 review deep: untrapped-spread at 2014 (base ceiling 2014)
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
[...wrap([1, 2], 2014)].join()
// ---
// A3 review deep: untrapped-spread at 2015 (base ceiling 2014)
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
[...wrap([1, 2], 2015)].join()
// ---
// A3 review deep: untrapped-spread at 2016 (base ceiling 2014)
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
[...wrap([1, 2], 2016)].join()
// ---
// A3 review deep: untrapped-symbol-keys at 999 (base ceiling 1999)
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
Symbol.prototype.length = 2; Array.from(Array.prototype.keys.call(wrap(Object(Symbol()), 999))).join()
// ---
// A3 review deep: untrapped-symbol-keys at 1998 (base ceiling 1999)
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
Symbol.prototype.length = 2; Array.from(Array.prototype.keys.call(wrap(Object(Symbol()), 1998))).join()
// ---
// A3 review deep: untrapped-symbol-keys at 1999 (base ceiling 1999)
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
Symbol.prototype.length = 2; Array.from(Array.prototype.keys.call(wrap(Object(Symbol()), 1999))).join()
// ---
// A3 review deep: untrapped-symbol-keys at 2000 (base ceiling 1999)
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
Symbol.prototype.length = 2; Array.from(Array.prototype.keys.call(wrap(Object(Symbol()), 2000))).join()
// ---
// A3 review deep: untrapped-symbol-keys at 2001 (base ceiling 1999)
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
Symbol.prototype.length = 2; Array.from(Array.prototype.keys.call(wrap(Object(Symbol()), 2001))).join()
// ---
// A3 review deep: trapped-chain at 29 (base ceiling 58)
var RG = { get: function (t, k, r) { return Reflect.get(t, k, r); } };
var p = [1, 2]; for (var i = 0; i < 29; i++) p = new Proxy(p, RG); Array.from(Array.prototype.values.call(p)).join()
// ---
// A3 review deep: trapped-chain at 57 (base ceiling 58)
var RG = { get: function (t, k, r) { return Reflect.get(t, k, r); } };
var p = [1, 2]; for (var i = 0; i < 57; i++) p = new Proxy(p, RG); Array.from(Array.prototype.values.call(p)).join()
// ---
// A3 review deep: trapped-chain at 58 (base ceiling 58)
var RG = { get: function (t, k, r) { return Reflect.get(t, k, r); } };
var p = [1, 2]; for (var i = 0; i < 58; i++) p = new Proxy(p, RG); Array.from(Array.prototype.values.call(p)).join()
// ---
// A3 review deep: trapped-chain at 59 (base ceiling 58)
var RG = { get: function (t, k, r) { return Reflect.get(t, k, r); } };
var p = [1, 2]; for (var i = 0; i < 59; i++) p = new Proxy(p, RG); Array.from(Array.prototype.values.call(p)).join()
// ---
// A3 review deep: trapped-chain at 60 (base ceiling 58)
var RG = { get: function (t, k, r) { return Reflect.get(t, k, r); } };
var p = [1, 2]; for (var i = 0; i < 60; i++) p = new Proxy(p, RG); Array.from(Array.prototype.values.call(p)).join()
// ---
// A3 review deep: trapped-chain-string at 29 (base ceiling 58)
var RG = { get: function (t, k, r) { return Reflect.get(t, k, r); } };
var p = new String('ab'); for (var i = 0; i < 29; i++) p = new Proxy(p, RG); Array.from(Array.prototype.values.call(p)).join()
// ---
// A3 review deep: trapped-chain-string at 57 (base ceiling 58)
var RG = { get: function (t, k, r) { return Reflect.get(t, k, r); } };
var p = new String('ab'); for (var i = 0; i < 57; i++) p = new Proxy(p, RG); Array.from(Array.prototype.values.call(p)).join()
// ---
// A3 review deep: trapped-chain-string at 58 (base ceiling 58)
var RG = { get: function (t, k, r) { return Reflect.get(t, k, r); } };
var p = new String('ab'); for (var i = 0; i < 58; i++) p = new Proxy(p, RG); Array.from(Array.prototype.values.call(p)).join()
// ---
// A3 review deep: trapped-chain-string at 59 (base ceiling 58)
var RG = { get: function (t, k, r) { return Reflect.get(t, k, r); } };
var p = new String('ab'); for (var i = 0; i < 59; i++) p = new Proxy(p, RG); Array.from(Array.prototype.values.call(p)).join()
// ---
// A3 review deep: trapped-chain-string at 60 (base ceiling 58)
var RG = { get: function (t, k, r) { return Reflect.get(t, k, r); } };
var p = new String('ab'); for (var i = 0; i < 60; i++) p = new Proxy(p, RG); Array.from(Array.prototype.values.call(p)).join()
// ---
// A3 review deep: trapped-chain-tk at 55 (base ceiling 111)
var TK = { get: function (t, k) { return t[k]; } }; var p = [1, 2]; for (var i = 0; i < 55; i++) p = new Proxy(p, TK); Array.from(Array.prototype.values.call(p)).join()
// ---
// A3 review deep: trapped-chain-tk at 110 (base ceiling 111)
var TK = { get: function (t, k) { return t[k]; } }; var p = [1, 2]; for (var i = 0; i < 110; i++) p = new Proxy(p, TK); Array.from(Array.prototype.values.call(p)).join()
// ---
// A3 review deep: trapped-chain-tk at 111 (base ceiling 111)
var TK = { get: function (t, k) { return t[k]; } }; var p = [1, 2]; for (var i = 0; i < 111; i++) p = new Proxy(p, TK); Array.from(Array.prototype.values.call(p)).join()
// ---
// A3 review deep: trapped-chain-tk at 112 (base ceiling 111)
var TK = { get: function (t, k) { return t[k]; } }; var p = [1, 2]; for (var i = 0; i < 112; i++) p = new Proxy(p, TK); Array.from(Array.prototype.values.call(p)).join()
// ---
// A3 review deep: trapped-chain-tk at 113 (base ceiling 111)
var TK = { get: function (t, k) { return t[k]; } }; var p = [1, 2]; for (var i = 0; i < 113; i++) p = new Proxy(p, TK); Array.from(Array.prototype.values.call(p)).join()
// ---
// A3 review deep: alternating at 57 (base ceiling 115)
var RG = { get: function (t, k, r) { return Reflect.get(t, k, r); } };
var p = { length: 2, 0: 'a', 1: 'b' }; for (var i = 0; i < 57; i++) p = new Proxy(p, i % 2 ? RG : {}); Array.from(Array.prototype.values.call(p)).join()
// ---
// A3 review deep: alternating at 114 (base ceiling 115)
var RG = { get: function (t, k, r) { return Reflect.get(t, k, r); } };
var p = { length: 2, 0: 'a', 1: 'b' }; for (var i = 0; i < 114; i++) p = new Proxy(p, i % 2 ? RG : {}); Array.from(Array.prototype.values.call(p)).join()
// ---
// A3 review deep: alternating at 115 (base ceiling 115)
var RG = { get: function (t, k, r) { return Reflect.get(t, k, r); } };
var p = { length: 2, 0: 'a', 1: 'b' }; for (var i = 0; i < 115; i++) p = new Proxy(p, i % 2 ? RG : {}); Array.from(Array.prototype.values.call(p)).join()
// ---
// A3 review deep: alternating at 116 (base ceiling 115)
var RG = { get: function (t, k, r) { return Reflect.get(t, k, r); } };
var p = { length: 2, 0: 'a', 1: 'b' }; for (var i = 0; i < 116; i++) p = new Proxy(p, i % 2 ? RG : {}); Array.from(Array.prototype.values.call(p)).join()
// ---
// A3 review deep: alternating at 117 (base ceiling 115)
var RG = { get: function (t, k, r) { return Reflect.get(t, k, r); } };
var p = { length: 2, 0: 'a', 1: 'b' }; for (var i = 0; i < 117; i++) p = new Proxy(p, i % 2 ? RG : {}); Array.from(Array.prototype.values.call(p)).join()
// ---
// A3 review deep: trap-over-untrapped at 982 (base ceiling 1964)
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
var RG = { get: function (t, k, r) { return Reflect.get(t, k, r); } };
Array.from(Array.prototype.values.call(new Proxy(wrap(new String('ab'), 982), RG))).join()
// ---
// A3 review deep: trap-over-untrapped at 1963 (base ceiling 1964)
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
var RG = { get: function (t, k, r) { return Reflect.get(t, k, r); } };
Array.from(Array.prototype.values.call(new Proxy(wrap(new String('ab'), 1963), RG))).join()
// ---
// A3 review deep: trap-over-untrapped at 1964 (base ceiling 1964)
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
var RG = { get: function (t, k, r) { return Reflect.get(t, k, r); } };
Array.from(Array.prototype.values.call(new Proxy(wrap(new String('ab'), 1964), RG))).join()
// ---
// A3 review deep: trap-over-untrapped at 1965 (base ceiling 1964)
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
var RG = { get: function (t, k, r) { return Reflect.get(t, k, r); } };
Array.from(Array.prototype.values.call(new Proxy(wrap(new String('ab'), 1965), RG))).join()
// ---
// A3 review deep: trap-over-untrapped at 1966 (base ceiling 1964)
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
var RG = { get: function (t, k, r) { return Reflect.get(t, k, r); } };
Array.from(Array.prototype.values.call(new Proxy(wrap(new String('ab'), 1966), RG))).join()
// ---
// A3 review deep: untrapped-over-trap-over-untrapped at 491 (base ceiling 982)
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
var RG = { get: function (t, k, r) { return Reflect.get(t, k, r); } };
Array.from(Array.prototype.entries.call(wrap(new Proxy(wrap([1, 2], 491), RG), 491))).join()
// ---
// A3 review deep: untrapped-over-trap-over-untrapped at 981 (base ceiling 982)
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
var RG = { get: function (t, k, r) { return Reflect.get(t, k, r); } };
Array.from(Array.prototype.entries.call(wrap(new Proxy(wrap([1, 2], 981), RG), 981))).join()
// ---
// A3 review deep: untrapped-over-trap-over-untrapped at 982 (base ceiling 982)
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
var RG = { get: function (t, k, r) { return Reflect.get(t, k, r); } };
Array.from(Array.prototype.entries.call(wrap(new Proxy(wrap([1, 2], 982), RG), 982))).join()
// ---
// A3 review deep: untrapped-over-trap-over-untrapped at 983 (base ceiling 982)
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
var RG = { get: function (t, k, r) { return Reflect.get(t, k, r); } };
Array.from(Array.prototype.entries.call(wrap(new Proxy(wrap([1, 2], 983), RG), 983))).join()
// ---
// A3 review deep: untrapped-over-trap-over-untrapped at 984 (base ceiling 982)
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
var RG = { get: function (t, k, r) { return Reflect.get(t, k, r); } };
Array.from(Array.prototype.entries.call(wrap(new Proxy(wrap([1, 2], 984), RG), 984))).join()
// ---
// A3 review deep: getter-recursion at 19 (base ceiling 39)
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
function f(n) { if (n === 0) return 0; var o = { length: 1, get 0() { return f(n - 1) + 1; } }; return Array.from(Array.prototype.values.call(wrap(o, 2)))[0]; } f(19)
// ---
// A3 review deep: getter-recursion at 38 (base ceiling 39)
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
function f(n) { if (n === 0) return 0; var o = { length: 1, get 0() { return f(n - 1) + 1; } }; return Array.from(Array.prototype.values.call(wrap(o, 2)))[0]; } f(38)
// ---
// A3 review deep: getter-recursion at 39 (base ceiling 39)
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
function f(n) { if (n === 0) return 0; var o = { length: 1, get 0() { return f(n - 1) + 1; } }; return Array.from(Array.prototype.values.call(wrap(o, 2)))[0]; } f(39)
// ---
// A3 review deep: getter-recursion at 40 (base ceiling 39)
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
function f(n) { if (n === 0) return 0; var o = { length: 1, get 0() { return f(n - 1) + 1; } }; return Array.from(Array.prototype.values.call(wrap(o, 2)))[0]; } f(40)
// ---
// A3 review deep: getter-recursion at 41 (base ceiling 39)
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
function f(n) { if (n === 0) return 0; var o = { length: 1, get 0() { return f(n - 1) + 1; } }; return Array.from(Array.prototype.values.call(wrap(o, 2)))[0]; } f(41)
// ---
// A3 review deep: trap-recursion at 29 (base ceiling 59)
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
function f(n) { if (n === 0) return 0; var p = new Proxy(wrap([0], 1), { get: function (t, k, r) { return k === '0' ? f(n - 1) + 1 : Reflect.get(t, k, r); } }); return [...Array.prototype.values.call(wrap(p, 1))][0]; } f(29)
// ---
// A3 review deep: trap-recursion at 58 (base ceiling 59)
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
function f(n) { if (n === 0) return 0; var p = new Proxy(wrap([0], 1), { get: function (t, k, r) { return k === '0' ? f(n - 1) + 1 : Reflect.get(t, k, r); } }); return [...Array.prototype.values.call(wrap(p, 1))][0]; } f(58)
// ---
// A3 review deep: trap-recursion at 59 (base ceiling 59)
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
function f(n) { if (n === 0) return 0; var p = new Proxy(wrap([0], 1), { get: function (t, k, r) { return k === '0' ? f(n - 1) + 1 : Reflect.get(t, k, r); } }); return [...Array.prototype.values.call(wrap(p, 1))][0]; } f(59)
// ---
// A3 review deep: trap-recursion at 60 (base ceiling 59)
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
function f(n) { if (n === 0) return 0; var p = new Proxy(wrap([0], 1), { get: function (t, k, r) { return k === '0' ? f(n - 1) + 1 : Reflect.get(t, k, r); } }); return [...Array.prototype.values.call(wrap(p, 1))][0]; } f(60)
// ---
// A3 review deep: trap-recursion at 61 (base ceiling 59)
function wrap(o, n) { for (var i = 0; i < n; i++) o = new Proxy(o, {}); return o; }
function f(n) { if (n === 0) return 0; var p = new Proxy(wrap([0], 1), { get: function (t, k, r) { return k === '0' ? f(n - 1) + 1 : Reflect.get(t, k, r); } }); return [...Array.prototype.values.call(wrap(p, 1))][0]; } f(61)
// ---
// A3 review deep: proto-chain-proxies at 998 (base ceiling 1996)
var o = [1, , 3]; var top = o; for (var i = 0; i < 998; i++) { var nx = Object.setPrototypeOf({}, new Proxy(Array.prototype, {})); Object.setPrototypeOf(top, new Proxy(nx, {})); top = nx; } Array.from(Array.prototype.values.call(new Proxy(o, {}))).join()
// ---
// A3 review deep: proto-chain-proxies at 1995 (base ceiling 1996)
var o = [1, , 3]; var top = o; for (var i = 0; i < 1995; i++) { var nx = Object.setPrototypeOf({}, new Proxy(Array.prototype, {})); Object.setPrototypeOf(top, new Proxy(nx, {})); top = nx; } Array.from(Array.prototype.values.call(new Proxy(o, {}))).join()
// ---
// A3 review deep: proto-chain-proxies at 1996 (base ceiling 1996)
var o = [1, , 3]; var top = o; for (var i = 0; i < 1996; i++) { var nx = Object.setPrototypeOf({}, new Proxy(Array.prototype, {})); Object.setPrototypeOf(top, new Proxy(nx, {})); top = nx; } Array.from(Array.prototype.values.call(new Proxy(o, {}))).join()
// ---
// A3 review deep: proto-chain-proxies at 1997 (base ceiling 1996)
var o = [1, , 3]; var top = o; for (var i = 0; i < 1997; i++) { var nx = Object.setPrototypeOf({}, new Proxy(Array.prototype, {})); Object.setPrototypeOf(top, new Proxy(nx, {})); top = nx; } Array.from(Array.prototype.values.call(new Proxy(o, {}))).join()
// ---
// A3 review deep: proto-chain-proxies at 1998 (base ceiling 1996)
var o = [1, , 3]; var top = o; for (var i = 0; i < 1998; i++) { var nx = Object.setPrototypeOf({}, new Proxy(Array.prototype, {})); Object.setPrototypeOf(top, new Proxy(nx, {})); top = nx; } Array.from(Array.prototype.values.call(new Proxy(o, {}))).join()
