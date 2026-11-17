const out = [];
try { new Array(70000).fill(0); out.push("70k fill ok"); } catch (e) { out.push("70k fill " + e.name + ": " + e.message); }
throw new Error(JSON.stringify(out));
