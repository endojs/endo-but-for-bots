const fr = new FinalizationRegistry(() => {}); const t = {};
for (let i = 0; i < 12000000; i++) fr.register(t, 0);
throw new Error("done 12M");
