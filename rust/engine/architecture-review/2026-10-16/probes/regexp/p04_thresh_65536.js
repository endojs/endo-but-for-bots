const s="a".repeat(65536); throw new Error(String(/a*/.exec(s)[0].length));
