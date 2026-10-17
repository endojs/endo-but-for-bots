let s = ''; for (let i = 0; i < 40; i++) s += String.fromCodePoint.apply(null, Array.from({length: 10000}, (_, k) => 0x10000 + k));
const ok = /^\P{Script=Kaithi}+$/u.test(s);
throw new Error('len=' + s.length + ' ' + ok);
