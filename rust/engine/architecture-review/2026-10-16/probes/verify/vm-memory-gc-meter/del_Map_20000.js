var wm = new Map(); var ks = []; for (var i = 0; i < 20000; i++) { var o = {}; ks.push(o); wm.set(o, i); } for (var i = 0; i < 20000; i++) wm.delete(ks[i]); throw new Error('done ' + i);
