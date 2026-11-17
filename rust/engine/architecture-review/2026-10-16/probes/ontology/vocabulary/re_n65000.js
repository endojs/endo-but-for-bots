const s = "a".repeat(65000);
throw new Error("ok " + /^a+$/.test(s));
