const s = "\u00e9".repeat(70000);
throw new Error(String(/^\P{ASCII}+$/u.test(s)));
