var it = [1, 2, 3][Symbol.iterator]();
var a = it.next(), b = it.next();
var out = ['same:' + (a === b), 'a.value:' + a.value, 'desc:' + JSON.stringify(Object.getOwnPropertyDescriptor(a, 'value'))];
var m = new Map([[1, 1], [2, 2]]).entries(); var c = m.next(), d = m.next(); out.push('map same:' + (c === d));
throw new Error(out.join(' | '));
