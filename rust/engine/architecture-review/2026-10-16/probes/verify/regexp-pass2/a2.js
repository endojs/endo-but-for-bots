const doc = "<script>" + "x;\n".repeat(20000) + "</script>"; const m = /<script>([\s\S]*?)<\/script>/.exec(doc); throw new Error(String(m[1].length));
