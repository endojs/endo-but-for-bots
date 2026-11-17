var wm = new Map(); var ks=[]; var i; for (i=0;i<40000;i++){var o={}; ks.push(o); wm.set(o,i);} for (i=0;i<40000;i++) wm.delete(ks[i]); throw new Error('done');
