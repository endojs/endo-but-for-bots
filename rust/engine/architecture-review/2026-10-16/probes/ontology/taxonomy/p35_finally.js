// Does a finally block run after a host stop?
globalThis.log = [];
try { "x".padEnd(2 ** 24 + 1, "x"); } finally { throw new Error("finally ran after host stop"); }
