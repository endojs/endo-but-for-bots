const s = JSON.stringify({k:"y".repeat(70000)}); const m = /"k":"([^"]*)"/.exec(s); throw new Error(String(m[1].length));
