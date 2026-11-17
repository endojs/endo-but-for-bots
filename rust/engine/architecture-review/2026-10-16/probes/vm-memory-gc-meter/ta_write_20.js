var u = new Uint8Array(1 << 20);
for (var i = 0; i < u.length; i++) u[i] = 1;
throw new Error("completed " + u.length);
