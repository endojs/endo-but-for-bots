throw new Error(String(/(?:a|b)*/.exec('a'.repeat(32768))[0].length));
