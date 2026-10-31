const fr = new FinalizationRegistry(() => {});
const t = {};
const tok = {};
for (let i = 0; i < 200000; i++) fr.register(t, i, tok);
const other = {};
for (let i = 0; i < 20000; i++) fr.unregister(other);
