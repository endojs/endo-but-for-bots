const s="a".repeat(65536); let c="no"; try { c=String(/a*/.exec(s)[0].length);} catch(e){c="caught "+e.name} throw new Error(c);
