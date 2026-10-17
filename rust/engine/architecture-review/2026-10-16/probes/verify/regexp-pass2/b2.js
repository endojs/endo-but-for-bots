// common library idioms
const r=/a/gi;
const clone = new RegExp(r.source, r.flags);
const keys=["global","ignoreCase","multiline"]; const f = keys.map(k=>r[k]);
throw new Error(JSON.stringify([clone.flags, f, String(r)]));
