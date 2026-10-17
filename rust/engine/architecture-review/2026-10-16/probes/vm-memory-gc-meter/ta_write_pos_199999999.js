var u = new Uint8Array(200000000); var k = 199999999; for (var i = 0; i < 1000000; i++) u[k] = 1; throw new Error("completed " + u[k]);
