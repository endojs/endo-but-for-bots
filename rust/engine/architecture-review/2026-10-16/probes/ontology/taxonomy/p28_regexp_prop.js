let r = [];
r.push(/^\p{ASCII}+$/u.test("abc"));
r.push(/\p{L}/u.test("x"));
throw new Error(JSON.stringify(r));
