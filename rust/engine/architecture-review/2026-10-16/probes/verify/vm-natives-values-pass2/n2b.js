var a = 10n ** 15000n; for (var i=0;i<3;i++) a = a*a; throw new Error(String(a.toString(16).length));
