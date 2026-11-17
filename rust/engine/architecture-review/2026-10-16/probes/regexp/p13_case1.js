const r = /a/; Object.defineProperty(r, "global", { value: "own" }); throw new Error(String(r.global));
