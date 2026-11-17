throw new Error(String(/(?:a|b)*/.exec('a'.repeat(32767))[0].length));
