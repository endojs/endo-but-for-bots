const s="a".repeat(65537); throw new Error(String(/a*/.exec(s)[0].length));
