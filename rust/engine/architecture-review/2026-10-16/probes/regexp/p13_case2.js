const r = /a/; Object.defineProperty(r, "source", { value: "own" }); throw new Error(String(r.source));
