const s = "a".repeat(70000);
throw new Error("ok " + /^a+$/.test(s));
