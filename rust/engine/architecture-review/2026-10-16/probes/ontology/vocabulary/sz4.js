const a = []; a.length = 17000001; throw new Error(String(Array.prototype.join.call({length: 17000001, 0: "x"}, "").length));
