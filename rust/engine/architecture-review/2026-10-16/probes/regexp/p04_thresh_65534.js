const s="a".repeat(65534); throw new Error(String(/a*/.exec(s)[0].length));
