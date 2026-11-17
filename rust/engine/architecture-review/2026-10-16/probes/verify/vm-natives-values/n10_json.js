const r = [];
for (const s of ['"\\u+041"', '"\\u+0041"', '"\\u-041"', '"\\u 041"']) { try { r.push(JSON.stringify(JSON.parse(s))); } catch (e) { r.push(e.name); } }
try { const v = JSON.rawJSON('"\\u+041"'); r.push('raw-ok:' + JSON.stringify({ v })); } catch (e) { r.push('raw:' + e.name); }
throw new Error(JSON.stringify(r));
