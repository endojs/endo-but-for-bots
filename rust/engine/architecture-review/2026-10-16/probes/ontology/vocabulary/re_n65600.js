const s = "a".repeat(65600);
throw new Error("ok " + /^a+$/.test(s));
