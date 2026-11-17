// A native callee accepts an argument list far beyond the 4,096-slot value stack.
const r = Math.max.apply(null, { length: 3000000 });
throw new Error('native apply 3e6 args => ' + r);
