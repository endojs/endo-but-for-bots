let caught="no"; try { /a*/.exec("a".repeat(100000)); } catch(e){ caught="caught "+e.name; } throw new Error(caught);
