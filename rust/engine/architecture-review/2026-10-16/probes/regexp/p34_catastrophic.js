let c="no"; try { /(a+)+$/.test("a".repeat(100)+"!"); } catch(e){c="caught "+e.name;} throw new Error(c);
