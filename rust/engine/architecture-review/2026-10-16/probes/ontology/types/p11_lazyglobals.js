var names = Object.getOwnPropertyNames(globalThis);
var want = ['Array','Map','WeakRef','Proxy','Reflect','JSON','Math','Atomics','Intl','parseInt','encodeURIComponent','escape','Iterator','AggregateError','FinalizationRegistry','BigInt64Array','SharedArrayBuffer','DataView','Promise','globalThis','NaN','Infinity','undefined','eval','isNaN','Symbol','Error','Float16Array'];
var missing = want.filter(function(n){ return names.indexOf(n) < 0; });
var hasIn = want.filter(function(n){ return !(n in globalThis); });
var desc = want.filter(function(n){ return !Object.getOwnPropertyDescriptor(globalThis, n); });
throw new Error(JSON.stringify({count: names.length, missingFromNames: missing.join(','), notIn: hasIn.join(','), noDesc: desc.join(',')}));
