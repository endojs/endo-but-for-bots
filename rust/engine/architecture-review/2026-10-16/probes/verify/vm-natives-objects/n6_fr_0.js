const fr = new FinalizationRegistry(() => {}); const t = {};
for (let i = 0; i < 0; i++) fr.register(t, 0);
throw new Error("done 0");
