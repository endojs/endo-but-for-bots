let r;
try { r = "join:" + ['a'.repeat(1<<20)].concat(Array(200).fill('a'.repeat(1<<20))).join('').length; } catch (e) { r = "caught " + e; }
throw new Error(r);
