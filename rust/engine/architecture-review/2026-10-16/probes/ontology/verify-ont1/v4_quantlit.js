const r = /b{2147483648}/;
throw new Error("ok " + r.test(""));
