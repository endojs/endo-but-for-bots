var s='b'.repeat(16); var r=/a/y; var c=0; for (var i=0;i<200;i++){ r.lastIndex=0; if (r.test(s)) c++; } throw new Error(String(c));
