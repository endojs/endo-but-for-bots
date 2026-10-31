const s="a".repeat(65535); throw new Error(String(/a*/.exec(s)[0].length));
