var s = Symbol("x"); var w = new WeakMap(); w.set(s, 1); var r1 = w.get(s); var w2 = new WeakMap([[s, 2]]); throw new Error(r1 + "," + w2.get(s));
