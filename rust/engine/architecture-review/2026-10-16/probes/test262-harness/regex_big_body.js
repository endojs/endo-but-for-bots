const s = buildString({ loneCodePoints: [], ranges: [[0x00DC00, 0x00DFFF],[0x000000, 0x00DBFF],[0x00E000, 0x01107F],[0x0110C3, 0x0110CC],[0x0110CE, 0x10FFFF]] });
const r = /^\P{Script=Kaithi}+$/u;
const ok = r.test(s);
throw new Error('len=' + s.length + ' test=' + ok);
