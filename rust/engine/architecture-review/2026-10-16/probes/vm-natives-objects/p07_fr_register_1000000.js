const fr = new FinalizationRegistry(() => {});
const t = {};
for (let i = 0; i < 1000000; i++) fr.register(t, i);
